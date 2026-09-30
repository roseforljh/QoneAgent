import { initRuntimeBridge } from "./store-bridge";
import { repeatedUserMessageId } from "@qone/protocol";
import { sessionStore, switchSessionState, type SessionExecutionState } from "./lib/session-execution-state";
import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { applyAssistantToolEvent, applyReasoningDelta, parseMcpCommand, DEFAULT_SUBAGENT_RUNTIME, REMOVED_BUILTIN_SUBAGENT_IDS, SKILL_CATALOG_TIMEOUT, type AssistantMessagePart, type CompactionMarkerInfo, type RuntimeCommand, type RuntimeEvent, type BrowserSyncStatus, type ReachChannelInfo, type SessionInfo, type SessionSearchResult, type MessageAttachmentInfo, type QueueItemInfo, type WorkspaceInfo, type WorkspaceFileInfo, type WorkspaceGitEntry, type ModelConfigInfo, type SkillInfo, type PluginInfo, type McpServerInfo, type RunInfo, type ArtifactInfo, type PermissionRuleInfo, type ProviderApiType, type RunPermissionMode, type RunThinkingLevel, type SubagentConfigInfo, type SubagentRunInfo, type GoalInfo } from "@qone/protocol";
import { loadDefaultPermissionMode, loadRunOptions, saveDefaultPermissionMode, saveRunOptions, type SessionRunOptions } from "./lib/run-options";
import { normalizeThinkingLevel } from "./lib/model-settings";
import { getLanguageSetting, resolveLocale, translate } from "./localization";
import { trackWorkspaceRequest, untrackWorkspaceRequest, useWorkspaceViewStore } from "./lib/workspace-view-state";

const displayRuntimeError = (message: string) => message === "MCP_NPX_UNAVAILABLE"
  ? translate(resolveLocale(getLanguageSetting()), "mcp.nodeRequired")
  : message;

export function hasTauriBridge() {
  return typeof window !== "undefined" && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  /** False until the runtime accepts this optimistic user turn. */
  persisted?: boolean;
  parts?: AssistantMessagePart[];
  attachments?: MessageAttachmentInfo[];
  runId?: string;
  goalId?: string;
  createdAt?: number;
}

export interface ChatRunError {
  sessionId: string;
  userMessageId: string;
  detail: string;
}

export interface PendingApproval {
  id: string;
  toolName: string;
  args: unknown;
}

export interface ToolCall {
  toolCallId: string;
  runId: string;
  toolName: string;
  status: "running" | "success" | "failed" | "waiting";
  args?: unknown;
  argsText?: string;
  result?: unknown;
  summary?: string;
  startedAt?: number;
  completedAt?: number;
}

function alignToolCallIds(calls: readonly ToolCall[], messages: readonly ChatMessage[]): ToolCall[] {
  const partsByRun = new Map<string, Extract<AssistantMessagePart, { type: "tool-call" }>[] >();
  for (const message of messages) {
    if (!message.runId || !message.parts) continue;
    const parts = message.parts.filter((part): part is Extract<AssistantMessagePart, { type: "tool-call" }> => part.type === "tool-call");
    if (parts.length > 0) partsByRun.set(message.runId, [...(partsByRun.get(message.runId) ?? []), ...parts]);
  }
  const used = new Map<string, Set<string>>();
  return calls.map((call) => {
    const runParts = partsByRun.get(call.runId) ?? [];
    const runUsed = used.get(call.runId) ?? new Set<string>();
    const exact = runParts.find((part) => part.toolCallId === call.toolCallId);
    const match = exact ?? runParts.find((part) => part.toolName === call.toolName && !runUsed.has(part.toolCallId));
    if (!match) return call;
    runUsed.add(match.toolCallId);
    used.set(call.runId, runUsed);
    return match.toolCallId === call.toolCallId ? call : { ...call, toolCallId: match.toolCallId };
  });
}

export interface AgentState {
  backgroundSessions: Record<string, SessionExecutionState>;
  connected: boolean;
  sessionsLoaded: boolean;
  workspacesLoaded: boolean;
  lastError?: string;
  chatRunError?: ChatRunError;
  compactionStatuses: Record<string, { requestId: string; throughMessageId: string; startedAt: number }>;
  autoCompactionStatuses: Record<string, { id: string; runId: string; throughMessageId: string; partIndex?: number; startedAt: number }>;
  compactions: CompactionMarkerInfo[];
  contextUsage?: { sessionId: string; model: string; tokens: number; contextWindow: number };
  contextUsageRequestId?: string;
  sessions: SessionInfo[];
  searchResults: SessionSearchResult[];
  searchLoading: boolean;
  activeSearchQuery: string;
  workspaces: WorkspaceInfo[];
  modelConfigs: ModelConfigInfo[];
  selectedModelId?: string;
  runOptionsBySession: Record<string, SessionRunOptions>;
  defaultPermissionMode: RunPermissionMode;
  draftRunOptions: SessionRunOptions;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcpServers: McpServerInfo[];
  subagentConfig: SubagentConfigInfo;
  subagents: SubagentRunInfo[];
  mcpConnectingIds: string[];
  browserStatus?: BrowserSyncStatus;
  reachChannels: ReachChannelInfo[];
  runs: RunInfo[];
  artifacts: ArtifactInfo[];
  currentWorkspaceId?: string;
  workspaceLoadingId?: string;
  currentSessionId?: string;
  goal?: GoalInfo;
  messagesLoadingSessionId?: string;
  draftWorkspaceId?: string;
  draftDockId: string;
  creatingSession: boolean;
  pendingMessage?: string;
  pendingGoal?: boolean;
  pendingAttachments?: MessageAttachmentInfo[];
  titleGeneratingSessionIds: string[];
  messages: ChatMessage[];
  queueItems: QueueItemInfo[];
  queueLoadedSessionId?: string;
  editingQueueItem?: QueueItemInfo;
  modelRequest?: { runId: string; startedAt: number };
  streaming: string;
  streamingParts: AssistantMessagePart[];
  activeMessageSequence?: number;
  /** Tool calls whose Pi arguments are complete but execution has not started yet. */
  preparedToolCallIds: string[];
  running: boolean;
  runningSessionIds: string[];
  activeRunId?: string;
  approvals: PendingApproval[];
  toolCalls: ToolCall[];
  permissionRules: PermissionRuleInfo[];
  workspaceFiles: WorkspaceFileInfo[];
  gitStatus: string;
  gitEntries: WorkspaceGitEntry[];
  gitLoaded: boolean;
  runtimeCapabilities: string[];
  globalPrompt: string;
  globalPromptPath?: string;
  globalPromptDirectory?: string;
  globalPromptLoaded: boolean;
  autoCompactionEnabled: boolean;
  compactionThreshold: number;
  workspaceError?: string;
  openFile?: { workspaceId: string; path: string; content: string };
  gitDiffView?: { workspaceId: string; path: string; diff: string };
  pinnedWorkspaceIds: string[];
  oauthAuthorization?: { requestId: string; serverId: string; url: string; state: string };
  githubDeviceAuthorization?: { serverId: string; userCode: string; verificationUri: string; expiresAt: number };
  send: (cmd: RuntimeCommand) => Promise<boolean>;
  newSession: () => void;
  newSessionInWorkspace: (workspaceId: string) => void;
  createSessionForWorkspace: (workspaceId: string) => void;
  renameSession: (id: string, title: string) => void;
  deleteSession: (id: string) => void;
  chooseWorkspace: () => void;
  renameWorkspace: (id: string, name: string) => void;
  deleteWorkspace: (id: string) => void;
  togglePinWorkspace: (id: string) => void;
  selectWorkspace: (id: string) => void;
  selectSession: (id: string) => void;
  searchSessions: (query: string) => void;
  runAgent: (message: string, replaceFromMessageId?: string, attachments?: MessageAttachmentInfo[], queueItemId?: string, goal?: boolean, sessionId?: string) => void;
  pauseGoal: () => void;
  resumeGoal: () => void;
  clearGoal: () => void;
  stopAgent: () => void;
  steerAgent: (input: { sessionId: string; runId: string; queueItemId: string; message: string; attachments?: MessageAttachmentInfo[] }) => Promise<boolean>;
  approve: (id: string) => void;
  reject: (id: string) => void;
  setPermission: (rule: Omit<PermissionRuleInfo, "updatedAt">) => void;
  refreshWorkspace: (id?: string) => void;
  setSelectedModel: (id: string) => void;
  setRunPermissionMode: (mode: RunPermissionMode) => void;
  setDefaultPermissionMode: (mode: RunPermissionMode) => void;
  setRunThinking: (modelId: string, level: RunThinkingLevel) => void;
  setCompactionSettings: (settings: { autoCompactionEnabled: boolean; compactionThreshold: number }) => void;
  compactSession: () => void;
  refreshContextUsage: () => void;
}

const rid = () => crypto.randomUUID();
function isCompactionMarker(value: unknown): value is CompactionMarkerInfo {
  if (!value || typeof value !== "object") return false;
  const marker = value as Partial<CompactionMarkerInfo>;
  return typeof marker.id === "string" && typeof marker.throughMessageId === "string" &&
    typeof marker.createdAt === "number" &&
    (marker.status === "completed" || marker.status === "interrupted") &&
    (marker.source === "manual" || marker.source === "automatic");
}
const BROWSER_AUTO_RECONNECT_KEY = "qone-browser-auto-reconnect";
const SUBAGENTS_STORAGE_KEY = "qone-subagents";
const CAPABILITY_ROUTING_STORAGE_KEY = "qone-capability-routing";
const SUBAGENT_RUNTIME_STORAGE_KEY = "qone-subagent-runtime";
const DEFAULT_COMPACTION_SETTINGS = { autoCompactionEnabled: true, compactionThreshold: 80 };

function loadLocalSubagentConfig(): SubagentConfigInfo {
  try {
    const profiles = JSON.parse(window.localStorage.getItem(SUBAGENTS_STORAGE_KEY) ?? "[]");
    const routing = JSON.parse(window.localStorage.getItem(CAPABILITY_ROUTING_STORAGE_KEY) ?? "{}");
    const runtime = JSON.parse(window.localStorage.getItem(SUBAGENT_RUNTIME_STORAGE_KEY) ?? "{}");
    return { profiles: Array.isArray(profiles) ? profiles.filter((profile) => profile && !REMOVED_BUILTIN_SUBAGENT_IDS.includes(profile.id)) : [], routing: routing && typeof routing === "object" ? routing : {}, runtime: { ...DEFAULT_SUBAGENT_RUNTIME, ...runtime }, updatedAt: Date.now() };
  } catch {
    return { profiles: [], routing: {}, runtime: DEFAULT_SUBAGENT_RUNTIME, updatedAt: Date.now() };
  }
}

function browserAutoReconnectEnabled(): boolean {
  try { return window.localStorage.getItem(BROWSER_AUTO_RECONNECT_KEY) === "1"; }
  catch { return false; }
}

function rememberBrowserConnection(): void {
  try { window.localStorage.setItem(BROWSER_AUTO_RECONNECT_KEY, "1"); }
  catch { /* Local storage may be unavailable in a restricted preview. */ }
}

const pendingAgentRuns = new Map<string, { requestId: string; sessionId: string; userMessageId: string }>();
const stopRequestedSessionIds = new Set<string>();
const stopRequests = new Map<string, { sessionId: string; runId: string }>();
function stopRun(sessionId: string, runId: string) {
  if ([...stopRequests.values()].some((request) => request.runId === runId)) return;
  const requestId = rid();
  stopRequests.set(requestId, { sessionId, runId });
  void useStore.getState().send({ type: "agent.stop", requestId, runId }).then((sent) => {
    if (!sent) stopRequests.delete(requestId);
  });
}
function finishStopRequest(sessionId: string, runId?: string) {
  stopRequestedSessionIds.delete(sessionId);
  for (const [requestId, request] of stopRequests) {
    if (request.sessionId === sessionId && (!runId || request.runId === runId)) stopRequests.delete(requestId);
  }
}
const steerRequests = new Map<string, { resolve: (accepted: boolean) => void }>();
const handshakeRequests = new Set<string>();
let metadataLookupSupported = false;
const metadataRequests = new Map<string, { resolve: (value: Extract<RuntimeEvent, { type: "model.metadata-resolved" }>["models"]) => void; reject: (error: Error) => void }>();
type CloudResponse = Extract<RuntimeEvent, { type: "skills.cloud.list" | "skills.cloud.installed" }>;
type CloudCommand = Extract<RuntimeCommand, { type: "skills.cloud.list" | "skills.cloud.install" }>;
type CloudInput = CloudCommand extends infer Command ? Command extends CloudCommand ? Omit<Command, "requestId"> : never : never;
type SkillMutationResponse = Extract<RuntimeEvent, { type: "skills.imported" | "skills.created" }>;
type SkillMutationCommand = Extract<RuntimeCommand, { type: "skills.import" | "skills.create" }>;
type SkillMutationInput = SkillMutationCommand extends infer Command ? Command extends SkillMutationCommand ? Omit<Command, "requestId"> : never : never;
const cloudRequests = new Map<string, { resolve: (response: CloudResponse) => void; reject: (error: Error) => void }>();
const skillMutationRequests = new Map<string, { resolve: (response: SkillMutationResponse) => void; reject: (error: Error) => void }>();
const cloudInFlight = new Map<string, Promise<CloudResponse>>();
const workspaceRequests = new Map<string, RuntimeCommand["type"]>();
const mcpConnectRequests = new Map<string, string>();
const restoredMcpSecrets = new Set<string>();

function finishMcpConnection(serverId: string) {
  for (const [requestId, id] of mcpConnectRequests) if (id === serverId) mcpConnectRequests.delete(requestId);
  useStore.setState((st) => ({ mcpConnectingIds: st.mcpConnectingIds.filter((id) => id !== serverId) }));
}

export function requestModelMetadata(input: Omit<Extract<RuntimeCommand, { type: "model.resolve-metadata" }>, "type" | "requestId">): Promise<Extract<RuntimeEvent, { type: "model.metadata-resolved" }>["models"]> {
  if (!hasTauriBridge()) return Promise.reject(new Error("Runtime is unavailable"));
  if (!useStore.getState().connected) return Promise.reject(new Error("Runtime is not connected"));
  if (!metadataLookupSupported) return Promise.reject(new Error("MODEL_METADATA_UNSUPPORTED"));
  const requestId = rid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { metadataRequests.delete(requestId); reject(new Error("Model metadata lookup timed out")); }, 15_000);
    metadataRequests.set(requestId, {
      resolve: (models) => { clearTimeout(timer); metadataRequests.delete(requestId); resolve(models); },
      reject: (error) => { clearTimeout(timer); metadataRequests.delete(requestId); reject(error); },
    });
    invoke("runtime_send", { cmd: JSON.stringify({ type: "model.resolve-metadata", requestId, ...input }) })
      .catch((error) => metadataRequests.get(requestId)?.reject(new Error(String(error))));
  });
}

export function requestSkillCloud(command: CloudInput): Promise<CloudResponse> {
  if (!hasTauriBridge() || !useStore.getState().connected) return Promise.reject(new Error("Runtime is unavailable"));
  const cacheKey = JSON.stringify(command);
  const existing = cloudInFlight.get(cacheKey);
  if (existing) return existing;
  const requestId = rid();
  const request = new Promise<CloudResponse>((resolve, reject) => {
    const timer = setTimeout(() => { cloudRequests.delete(requestId); reject(new Error(SKILL_CATALOG_TIMEOUT)); }, command.type === "skills.cloud.install" ? 120_000 : 60_000);
    cloudRequests.set(requestId, {
      resolve: (response) => { clearTimeout(timer); cloudRequests.delete(requestId); resolve(response); },
      reject: (error) => { clearTimeout(timer); cloudRequests.delete(requestId); reject(error); },
    });
    useStore.getState().send({ ...command, requestId } as CloudCommand).then((sent) => {
      if (!sent) cloudRequests.get(requestId)?.reject(new Error("云库请求发送失败"));
    });
  });
  cloudInFlight.set(cacheKey, request);
  void request.then(() => cloudInFlight.delete(cacheKey), () => cloudInFlight.delete(cacheKey));
  return request;
}

export function requestSkillMutation(command: SkillMutationInput): Promise<SkillMutationResponse> {
  if (!hasTauriBridge() || !useStore.getState().connected) return Promise.reject(new Error("Runtime is unavailable"));
  const requestId = rid();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { skillMutationRequests.delete(requestId); reject(new Error("Skill 操作超时")); }, 20_000);
    skillMutationRequests.set(requestId, {
      resolve: (response) => { clearTimeout(timer); skillMutationRequests.delete(requestId); resolve(response); },
      reject: (error) => { clearTimeout(timer); skillMutationRequests.delete(requestId); reject(error); },
    });
    useStore.getState().send({ ...command, requestId } as SkillMutationCommand).then((sent) => {
      if (!sent) skillMutationRequests.get(requestId)?.reject(new Error("Skill 操作发送失败"));
    });
  });
}

export const useStore = create<AgentState>((set, get) => ({
  backgroundSessions: {},
  connected: false,
  sessionsLoaded: !hasTauriBridge(),
  workspacesLoaded: !hasTauriBridge(),
  lastError: undefined,
  chatRunError: undefined,
  compactionStatuses: {},
  autoCompactionStatuses: {},
  compactions: [],
  contextUsage: undefined,
  contextUsageRequestId: undefined,
  sessions: [],
  searchResults: [],
  searchLoading: false,
  activeSearchQuery: "",
  workspaces: [],
  modelConfigs: [],
  selectedModelId: undefined,
  runOptionsBySession: loadRunOptions(),
  defaultPermissionMode: loadDefaultPermissionMode(),
  draftRunOptions: {},
  draftDockId: crypto.randomUUID(),
  skills: [],
  plugins: [],
  mcpServers: [],
  subagentConfig: loadLocalSubagentConfig(),
  subagents: [],
  mcpConnectingIds: [],
  browserStatus: undefined,
  reachChannels: [],
  runs: [],
  artifacts: [],
  messages: [],
  queueItems: [],
  queueLoadedSessionId: undefined,
  editingQueueItem: undefined,
  messagesLoadingSessionId: undefined,
  streaming: "",
  streamingParts: [],
  activeMessageSequence: undefined,
  preparedToolCallIds: [],
  running: false,
  runningSessionIds: [],
  draftWorkspaceId: undefined,
  creatingSession: false,
  pendingMessage: undefined,
  titleGeneratingSessionIds: [],
  activeRunId: undefined,
  approvals: [],
  toolCalls: [],
  permissionRules: [],
  workspaceFiles: [],
  gitStatus: "",
  gitEntries: [],
  gitLoaded: false,
  runtimeCapabilities: [],
  globalPrompt: "",
  globalPromptPath: undefined,
  globalPromptDirectory: undefined,
  globalPromptLoaded: !hasTauriBridge(),
  ...DEFAULT_COMPACTION_SETTINGS,
  workspaceError: undefined,
  pinnedWorkspaceIds: (() => {
    try {
      const raw = window.localStorage.getItem("qone-pinned-workspaces");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch { return []; }
  })(),

  send: (cmd) => {
    // Browser previews do not expose Tauri's invoke bridge.
    if (!hasTauriBridge()) return Promise.resolve(false);
    if (cmd.type === "ping") handshakeRequests.add(cmd.requestId);
    if (cmd.type === "workspace.files" || cmd.type === "workspace.git" || cmd.type === "workspace.gitDiff" || cmd.type === "file.read") {
      workspaceRequests.set(cmd.requestId, cmd.type);
      trackWorkspaceRequest({
        requestId: cmd.requestId,
        type: cmd.type,
        workspaceId: cmd.workspaceId,
        path: "path" in cmd ? (cmd.path as string) : undefined,
        scope: "scope" in cmd ? (cmd.scope as "staged" | "unstaged") : undefined,
      });
    }
    if (cmd.type === "mcp.connect") {
      mcpConnectRequests.set(cmd.requestId, cmd.config.id);
      set((st) => ({ mcpConnectingIds: st.mcpConnectingIds.includes(cmd.config.id) ? st.mcpConnectingIds : [...st.mcpConnectingIds, cmd.config.id] }));
    }
    if (cmd.type === "secret.set" && cmd.key.startsWith("mcp.env:")) restoredMcpSecrets.add(cmd.key);
    if (cmd.type === "mcp.delete") {
      finishMcpConnection(cmd.serverId);
      restoredMcpSecrets.delete(`mcp.oauth:${cmd.serverId}`);
      restoredMcpSecrets.delete(`mcp.oauth:${cmd.serverId}.client`);
      restoredMcpSecrets.delete(`mcp.oauth:${cmd.serverId}.tokens`);
      const server = get().mcpServers.find((item) => item.id === cmd.serverId);
      for (const value of Object.values(server?.env ?? {})) {
        if (value.startsWith("$mcp.env:")) restoredMcpSecrets.delete(value.slice(1));
      }
      set((st) => ({
        oauthAuthorization: st.oauthAuthorization?.serverId === cmd.serverId ? undefined : st.oauthAuthorization,
        githubDeviceAuthorization: st.githubDeviceAuthorization?.serverId === cmd.serverId ? undefined : st.githubDeviceAuthorization,
      }));
    }
    return invoke("runtime_send", { cmd: JSON.stringify(cmd) }).then(() => true).catch((error) => {
      console.error("runtime_send failed", error);
      if (cmd.type === "mcp.connect") finishMcpConnection(cmd.config.id);
      if (cmd.type === "secret.set" && cmd.key.startsWith("mcp.env:")) restoredMcpSecrets.delete(cmd.key);
      if (cmd.type === "agent.run" || cmd.type === "goal.start") {
        if (!cmd.messageId || !pendingAgentRuns.has(cmd.requestId)) return false;
        pendingAgentRuns.delete(cmd.requestId);
        finishStopRequest(cmd.sessionId);
        {
          clearDelta(cmd.sessionId);
          sessionStore(useStore, cmd.sessionId).setState({
            chatRunError: { sessionId: cmd.sessionId, userMessageId: cmd.messageId, detail: String(error) },
            running: false,
            streaming: "",
            streamingParts: [],
            activeMessageSequence: undefined,
            preparedToolCallIds: [],
            activeRunId: undefined,
          });
        }
        set((state) => ({ runningSessionIds: state.runningSessionIds.filter((id) => id !== cmd.sessionId), titleGeneratingSessionIds: state.titleGeneratingSessionIds.filter((id) => id !== cmd.sessionId) }));
      } else if (cmd.type === "session.generate-title") {
        pendingTitleRequests.delete(cmd.requestId);
        set((state) => ({ titleGeneratingSessionIds: state.titleGeneratingSessionIds.filter((id) => id !== cmd.sessionId) }));
      } else if (workspaceRequests.delete(cmd.requestId)) {
        const rec = untrackWorkspaceRequest(cmd.requestId);
        if (rec?.ownerId) {
          useWorkspaceViewStore.getState().setError(rec.ownerId, String(error));
        } else if (!rec || rec.workspaceId === get().currentWorkspaceId) {
          set({ lastError: String(error), workspaceError: String(error) });
        } else {
          set({ lastError: String(error) });
        }
      } else {
        set({ lastError: String(error) });
      }
      return false;
    });
  },

  newSession: () => {
    const state = get();
    const workspaceId = state.currentWorkspaceId;
    if (!workspaceId || !state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      set({ lastError: "请先导入项目，再创建会话。" });
      return;
    }
    set({ draftRunOptions: {}, lastError: undefined });
    get().send({ type: "session.create", requestId: rid(), workspaceId });
  },

  newSessionInWorkspace: (workspaceId) => {
    if (!get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
    flushNow();
    set({ currentWorkspaceId: workspaceId, workspaceLoadingId: workspaceId, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined, currentSessionId: undefined, messagesLoadingSessionId: undefined, draftWorkspaceId: workspaceId, draftDockId: crypto.randomUUID(), draftRunOptions: {}, creatingSession: false, pendingMessage: undefined, messages: [], compactions: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], subagents: [], artifacts: [], running: false, activeRunId: undefined, modelRequest: undefined, approvals: [], lastError: undefined, chatRunError: undefined, ...switchSessionState(get()) });
    get().refreshWorkspace(workspaceId);
  },

  createSessionForWorkspace: (workspaceId) => {
    if (get().creatingSession || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
    set({ creatingSession: true, currentWorkspaceId: workspaceId, draftWorkspaceId: workspaceId, lastError: undefined });
    get().send({ type: "session.create", requestId: rid(), title: "New session", workspaceId });
  },

  renameSession: (id, title) => {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    get().send({ type: "session.rename", requestId: rid(), sessionId: id, title: normalizedTitle });
  },

  deleteSession: (id) => {
    get().send({ type: "session.delete", requestId: rid(), sessionId: id });
    set((state) => {
      const runOptionsBySession = { ...state.runOptionsBySession };
      delete runOptionsBySession[id];
      saveRunOptions(runOptionsBySession);
      return { runOptionsBySession };
    });
    get().send({ type: "session.list", requestId: rid() });
  },

  renameWorkspace: (id, name) => {
    if (!name.trim()) return;
    get().send({ type: "workspace.rename", requestId: rid(), workspaceId: id, name: name.trim() });
  },

  deleteWorkspace: (id) => {
    get().send({ type: "workspace.delete", requestId: rid(), workspaceId: id });
  },

  togglePinWorkspace: (id) => {
    set((s) => {
      const pinnedWorkspaceIds = s.pinnedWorkspaceIds.includes(id)
        ? s.pinnedWorkspaceIds.filter((pinnedId) => pinnedId !== id)
        : [...s.pinnedWorkspaceIds, id];
      window.localStorage.setItem("qone-pinned-workspaces", JSON.stringify(pinnedWorkspaceIds));
      return { pinnedWorkspaceIds };
    });
  },

  selectWorkspace: (id) => {
    if (!get().workspaces.some((workspace) => workspace.id === id)) return;
    set((state) => state.currentWorkspaceId === id ? {} : { currentWorkspaceId: id, workspaceLoadingId: id, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined, ...(!state.currentSessionId ? { draftDockId: crypto.randomUUID() } : {}) });
    get().refreshWorkspace(id);
  },

  chooseWorkspace: () => {
    if (!hasTauriBridge()) {
      set({ lastError: "当前是 Vite 网页预览，未连接 Tauri 原生运行时。请使用 bun run --cwd apps/desktop tauri dev 测试项目导入和 AI 对话。" });
      return;
    }
    invoke<string | null>("pick_workspace")
      .then((path) => {
        if (!path) return;
        get().send({
          type: "workspace.upsert",
          requestId: rid(),
          name: path.split(/[\\/]/).filter(Boolean).pop() ?? path,
          path,
        });
      })
      .catch((error) => {
        console.error("workspace picker failed", error);
        set({ lastError: `项目选择器打开失败：${String(error)}` });
      });
  },

  selectSession: (id) => {
    if (get().currentSessionId === id) return;
    flushNow();
    const workspaceId = get().sessions.find((session) => session.id === id)?.workspaceId;
    const workspaceChanged = workspaceId !== undefined && workspaceId !== get().currentWorkspaceId;
    set({ currentSessionId: id, queueItems: [], queueLoadedSessionId: undefined, editingQueueItem: undefined, selectedModelId: get().runOptionsBySession[id]?.modelId, currentWorkspaceId: workspaceId ?? get().currentWorkspaceId, ...(workspaceChanged ? { workspaceLoadingId: workspaceId, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined } : {}), draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], compactions: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], subagents: [], artifacts: [], running: false, activeRunId: undefined, modelRequest: undefined, approvals: [], chatRunError: undefined, ...switchSessionState(get(), id), messagesLoadingSessionId: id });
    get().send({ type: "session.messages", requestId: rid(), sessionId: id });
    get().send({ type: "goal.get", requestId: rid(), sessionId: id });
    get().send({ type: "session.queue.list", requestId: rid(), sessionId: id });
    get().send({ type: "session.toolCalls", requestId: rid(), sessionId: id });
    get().send({ type: "session.runs", requestId: rid(), sessionId: id });
    get().send({ type: "session.subagents", requestId: rid(), sessionId: id });
    get().send({ type: "artifact.list", requestId: rid(), sessionId: id });
    if (workspaceId) get().refreshWorkspace(workspaceId);
  },

  searchSessions: (query) => {
    const normalized = query.trim();
    if (!normalized) {
      set({ searchResults: [], searchLoading: false, activeSearchQuery: "" });
      return;
    }
    set({ searchLoading: true, activeSearchQuery: normalized });
    void get().send({ type: "session.search", requestId: rid(), query: normalized }).then((sent) => {
      if (!sent) set({ searchLoading: false });
    });
  },

  runAgent: (message, replaceFromMessageId, attachments, queueItemId, goal, sessionId) => {
    const { getState: get, setState: set } = sessionStore(useStore, sessionId);
    const mcpCommand = parseMcpCommand(message);
    if (mcpCommand) {
      const server = get().mcpServers.find((item) => item.id === mcpCommand.serverId);
      if (!server?.connected || !(server.toolCount && server.toolCount > 0)) {
        set({ lastError: "所选 MCP 服务未连接或没有可用工具。" });
        return;
      }
      if (!mcpCommand.text && !attachments?.length) {
        set({ lastError: "选择 MCP 服务后，请输入消息或添加附件。" });
        return;
      }
      if (goal) {
        set({ lastError: "Goal 暂不支持指定 MCP 服务。" });
        return;
      }
    }
    const sid = get().currentSessionId;
    if (!sid) {
      const workspaceId = get().draftWorkspaceId;
      if (!workspaceId || get().creatingSession || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
      set({ pendingMessage: message, pendingGoal: goal, pendingAttachments: attachments, currentWorkspaceId: workspaceId, lastError: undefined });
      get().createSessionForWorkspace(workspaceId);
      return;
    }
    const session = get().sessions.find((item) => item.id === sid);
    if (!session?.workspaceId || !get().workspaces.some((workspace) => workspace.id === session.workspaceId)) return;
    if (get().running || get().compactionStatuses[sid]) return;
    if (!hasTauriBridge()) { set({ lastError: "当前未连接桌面运行时，无法发送消息。" }); return; }
    const history = get().messages;
    replaceFromMessageId ??= repeatedUserMessageId(history, { content: message, attachments });
    const replaceIndex = replaceFromMessageId
      ? history.findIndex((item) => item.id === replaceFromMessageId && item.role === "user")
      : -1;
    if (replaceFromMessageId && replaceIndex < 0) return;
    const persistedReplaceId = replaceIndex >= 0 && history[replaceIndex]?.persisted !== false ? replaceFromMessageId : undefined;
    if (persistedReplaceId) pendingMessageReplacements.set(sid, persistedReplaceId);
    const keptMessages = replaceIndex >= 0 ? history.slice(0, replaceIndex) : history;
    const keptRunIds = new Set(keptMessages.flatMap((item) => item.runId ? [item.runId] : []));
    const messageId = rid();
    clearDelta(sid);
    set((s) => ({
      messages: [...keptMessages, { id: messageId, role: "user", content: message, persisted: false, attachments, goalId: goal ? "__pending_goal__" : undefined, createdAt: Date.now() }],
      compactions: replaceIndex >= 0 ? s.compactions.filter((marker) => keptMessages.some((item) => item.id === marker.throughMessageId)) : s.compactions,
      streaming: "",
      streamingParts: [],
      activeMessageSequence: undefined,
      preparedToolCallIds: [],
      running: true,
      runningSessionIds: s.runningSessionIds.includes(sid) ? s.runningSessionIds : [...s.runningSessionIds, sid],
      contextUsage: undefined,
      contextUsageRequestId: undefined,
      creatingSession: false,
      pendingMessage: undefined,
      pendingGoal: undefined,
      pendingAttachments: undefined,
      lastError: undefined,
      chatRunError: undefined,
      toolCalls: replaceIndex >= 0 ? s.toolCalls.filter((call) => keptRunIds.has(call.runId)) : s.toolCalls,
      runs: replaceIndex >= 0 ? s.runs.filter((run) => keptRunIds.has(run.id)) : s.runs,
      subagents: replaceIndex >= 0 ? s.subagents.filter((item) => keptRunIds.has(item.parentRunId)) : s.subagents,
      titleGeneratingSessionIds: s.messages.length === 0 && !s.titleGeneratingSessionIds.includes(sid)
        ? [...s.titleGeneratingSessionIds, sid]
        : s.titleGeneratingSessionIds,
    }));
    const options = get().runOptionsBySession[sid];
    const model = options?.modelId ?? get().selectedModelId;
    const modelConfig = get().modelConfigs.find((item) => item.id === model)?.config;
    const apiType = modelConfig?.apiType as ProviderApiType | undefined;
    const requestedThinking = model ? options?.thinkingByModel?.[model] : undefined;
    const thinking = requestedThinking === undefined ? undefined : normalizeThinkingLevel(requestedThinking, apiType);
    const requestId = rid();
    pendingAgentRuns.set(requestId, { requestId, sessionId: sid, userMessageId: messageId });
    get().send(goal
      ? { type: "goal.start", requestId, sessionId: sid, objective: message, attachments, messageId, replaceFromMessageId: persistedReplaceId, model, permissionMode: options?.permissionMode ?? get().defaultPermissionMode, thinking }
      : { type: "agent.run", requestId, sessionId: sid, message, attachments, messageId, replaceFromMessageId: persistedReplaceId, queueItemId, model, permissionMode: options?.permissionMode ?? get().defaultPermissionMode, thinking, mcpServerId: mcpCommand?.serverId });
    if (history.length === 0) {
      const titleRequestId = rid();
      pendingTitleRequests.set(titleRequestId, sid);
      get().send({ type: "session.generate-title", requestId: titleRequestId, sessionId: sid, prompt: (mcpCommand ? mcpCommand.text : message) || attachments?.map((attachment) => attachment.name).join(", ") || "图片", model });
    }
  },

  stopAgent: () => {
    const { currentSessionId, activeRunId, running } = get();
    if (!currentSessionId || !running) return;
    stopRequestedSessionIds.add(currentSessionId);
    if (activeRunId) stopRun(currentSessionId, activeRunId);
    else void get().send({ type: "session.runs", requestId: rid(), sessionId: currentSessionId });
  },

  pauseGoal: () => { const sessionId = get().currentSessionId; if (sessionId) void get().send({ type: "goal.pause", requestId: rid(), sessionId }); },
  resumeGoal: () => { const sessionId = get().currentSessionId; if (sessionId) void get().send({ type: "goal.resume", requestId: rid(), sessionId }); },
  clearGoal: () => { const sessionId = get().currentSessionId; if (sessionId) void get().send({ type: "goal.clear", requestId: rid(), sessionId }); },

  steerAgent: async ({ sessionId, runId, queueItemId, message, attachments }) => {
    const requestId = rid();
    return new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => { steerRequests.delete(requestId); resolve(false); }, 15_000);
      steerRequests.set(requestId, {
        resolve: (accepted) => { clearTimeout(timer); steerRequests.delete(requestId); resolve(accepted); },
      });
      get().send({ type: "agent.steer", requestId, sessionId, runId, queueItemId, message, attachments }).then((sent) => {
        if (!sent) steerRequests.get(requestId)?.resolve(false);
      });
    });
  },

  approve: (id) => {
    get().send({ type: "tool.approve", requestId: rid(), approvalId: id });
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }));
  },

  reject: (id) => {
    get().send({ type: "tool.reject", requestId: rid(), approvalId: id });
    set((s) => ({ approvals: s.approvals.filter((a) => a.id !== id) }));
  },

  setPermission: (rule) => get().send({ type: "permission.set", requestId: rid(), ...rule }),

  setCompactionSettings: (settings) => {
    const compactionThreshold = Math.min(95, Math.max(50, Math.round(settings.compactionThreshold)));
    const next = { autoCompactionEnabled: settings.autoCompactionEnabled, compactionThreshold };
    set(next);
    void get().send({ type: "compaction.settings.set", requestId: rid(), ...next });
  },
  compactSession: () => {
    const { currentSessionId, selectedModelId, connected, compactionStatuses, messages, messagesLoadingSessionId, running } = get();
    if (!connected || !currentSessionId || !selectedModelId) {
      set({ lastError: "请先连接运行时、选择会话和模型。" });
      return;
    }
    if (running || messagesLoadingSessionId === currentSessionId || !messages.length || compactionStatuses[currentSessionId]) return;
    const requestId = rid();
    set((state) => ({ compactionStatuses: { ...state.compactionStatuses, [currentSessionId]: { requestId, throughMessageId: messages.at(-1)!.id, startedAt: Date.now() } }, contextUsage: undefined, contextUsageRequestId: undefined, lastError: undefined }));
    void get().send({ type: "session.compact", requestId, sessionId: currentSessionId, model: selectedModelId }).then((sent) => {
      if (!sent) set((state) => {
        if (state.compactionStatuses[currentSessionId]?.requestId !== requestId) return state;
        const compactionStatuses = { ...state.compactionStatuses };
        delete compactionStatuses[currentSessionId];
        return { compactionStatuses };
      });
    });
  },
  refreshContextUsage: () => {
    const { connected, currentSessionId, selectedModelId } = get();
    if (!connected || !currentSessionId || !selectedModelId) return;
    const requestId = rid();
    set({ contextUsageRequestId: requestId, contextUsage: undefined });
    void get().send({ type: "session.context.get", requestId, sessionId: currentSessionId, model: selectedModelId }).then((sent) => {
      if (!sent) set((state) => state.contextUsageRequestId === requestId ? { contextUsageRequestId: undefined } : state);
    });
  },

  refreshWorkspace: (id = get().currentWorkspaceId) => {
    if (!id) return;
    get().send({ type: "workspace.files", requestId: rid(), workspaceId: id });
    get().send({ type: "workspace.git", requestId: rid(), workspaceId: id });
  },

  setSelectedModel: (id) => set((state) => {
    const sid = state.currentSessionId;
    if (!sid) return {
      selectedModelId: id,
      draftRunOptions: { ...state.draftRunOptions, modelId: id },
    };
    const runOptionsBySession = {
      ...state.runOptionsBySession,
      [sid]: { ...state.runOptionsBySession[sid], modelId: id },
    };
    saveRunOptions(runOptionsBySession);
    return { selectedModelId: id, runOptionsBySession };
  }),
  setRunPermissionMode: (mode) => set((state) => {
    const sid = state.currentSessionId;
    if (!sid) return { draftRunOptions: { ...state.draftRunOptions, permissionMode: mode } };
    const runOptionsBySession = { ...state.runOptionsBySession, [sid]: { ...state.runOptionsBySession[sid], permissionMode: mode } };
    saveRunOptions(runOptionsBySession);
    return { runOptionsBySession };
  }),
  setDefaultPermissionMode: (mode) => {
    saveDefaultPermissionMode(mode);
    set({ defaultPermissionMode: mode });
  },
  setRunThinking: (modelId, level) => set((state) => {
    const sid = state.currentSessionId;
    if (!sid) return { draftRunOptions: { ...state.draftRunOptions, thinkingByModel: { ...state.draftRunOptions.thinkingByModel, [modelId]: level } } };
    const current = state.runOptionsBySession[sid];
    const runOptionsBySession = { ...state.runOptionsBySession, [sid]: { ...current, thinkingByModel: { ...current?.thinkingByModel, [modelId]: level } } };
    saveRunOptions(runOptionsBySession);
    return { runOptionsBySession };
  }),
}));

// Flush each session independently so navigation cannot redirect buffered tokens.
const deltas = new Map<string, { text: string; reasoning?: { delta: string; contentIndex?: number }; timer?: ReturnType<typeof setTimeout> }>();
function bufferFor(sessionId: string) {
  let buffer = deltas.get(sessionId);
  if (!buffer) { buffer = { text: "" }; deltas.set(sessionId, buffer); }
  if (!buffer.timer) buffer.timer = setTimeout(() => flushNow(sessionId), 32);
  return buffer;
}
function queueDelta(delta: string, sessionId = useStore.getState().currentSessionId) {
  if (sessionId) bufferFor(sessionId).text += delta;
}
function queueReasoning(delta: string, contentIndex?: number, sessionId = useStore.getState().currentSessionId) {
  if (!sessionId) return;
  if (deltas.get(sessionId)?.reasoning?.contentIndex !== contentIndex) flushNow(sessionId);
  const buffer = bufferFor(sessionId);
  buffer.reasoning = { delta: (buffer.reasoning?.delta ?? "") + delta, contentIndex };
}
function flushNow(sessionId = useStore.getState().currentSessionId) {
  if (!sessionId) return;
  const buffer = deltas.get(sessionId);
  if (!buffer) return;
  clearDelta(sessionId);
  const { text, reasoning } = buffer;
  sessionStore(useStore, sessionId).setState((st) => ({
    streaming: st.streaming + text,
    streamingParts: reasoning && st.activeMessageSequence !== undefined
      ? applyReasoningDelta(st.streamingParts, reasoning, st.activeMessageSequence) : st.streamingParts,
  }));
}
function clearDelta(sessionId = useStore.getState().currentSessionId) {
  if (!sessionId) return;
  const buffer = deltas.get(sessionId);
  if (buffer?.timer) clearTimeout(buffer.timer);
  deltas.delete(sessionId);
}

function ensureStreamingToolPart(
  parts: readonly AssistantMessagePart[],
  payload: Record<string, unknown>,
  messageSequence: number,
): AssistantMessagePart[] {
  const toolCallId = typeof payload.toolCallId === "string" && payload.toolCallId
    ? payload.toolCallId
    : undefined;
  if (!toolCallId) return [...parts];
  const hasPart = parts.some((part) => part.type === "tool-call" && part.toolCallId === toolCallId);
  const next = hasPart ? [...parts] : [
    ...parts,
    {
      type: "tool-call" as const,
      toolCallId,
      toolName: typeof payload.toolName === "string" && payload.toolName ? payload.toolName : "tool",
      args: payload.args ?? payload.input ?? {},
      messageSequence,
    },
  ];
  return applyAssistantToolEvent(next, "tool.started", payload);
}

// A reload removes the selected user turn in the runtime database. Ignore an
// older session.messages response that still contains that turn, otherwise a
// delayed response can restore the old bubble beside the replacement.
const pendingMessageReplacements = new Map<string, string>();
const pendingTitleRequests = new Map<string, string>();

export function bridgeDependencies() {
  return { useStore, hasTauriBridge, clearDelta, flushNow, queueDelta, queueReasoning, deltas, pendingAgentRuns, stopRequestedSessionIds, stopRequests, pendingTitleRequests, mcpConnectRequests, restoredMcpSecrets, metadataRequests, finishMcpConnection, handshakeRequests, steerRequests, workspaceRequests, cloudRequests, skillMutationRequests, pendingMessageReplacements, stopRun, finishStopRequest, rememberBrowserConnection, browserAutoReconnectEnabled, displayRuntimeError, isCompactionMarker, alignToolCallIds, ensureStreamingToolPart, setMetadataLookupSupported: (supported: boolean) => { metadataLookupSupported = supported; } };
}

export function initBridge() { initRuntimeBridge(bridgeDependencies()); }
