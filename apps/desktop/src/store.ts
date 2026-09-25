import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { assistantPartsFromPiMessage, applyAssistantToolEvent, type AssistantMessagePart, type RuntimeCommand, type RuntimeEvent, type BrowserSyncStatus, type SessionInfo, type MessageInfo, type MessageAttachmentInfo, type WorkspaceInfo, type WorkspaceFileInfo, type WorkspaceGitEntry, type ModelConfigInfo, type SkillInfo, type PluginInfo, type McpServerInfo, type RunInfo, type ArtifactInfo, type PermissionRuleInfo, type ProviderApiType, type RunPermissionMode, type RunThinkingLevel } from "@qone/protocol";
import { loadDefaultPermissionMode, loadRunOptions, saveDefaultPermissionMode, saveRunOptions, type SessionRunOptions } from "./lib/run-options";
import { normalizeThinkingLevel } from "./lib/model-settings";
import { getLanguageSetting, resolveLocale, translate } from "./localization";

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
  parts?: AssistantMessagePart[];
  attachments?: MessageAttachmentInfo[];
  runId?: string;
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

interface AgentState {
  connected: boolean;
  sessionsLoaded: boolean;
  workspacesLoaded: boolean;
  lastError?: string;
  chatRunError?: ChatRunError;
  sessions: SessionInfo[];
  workspaces: WorkspaceInfo[];
  modelConfigs: ModelConfigInfo[];
  selectedModelId?: string;
  runOptionsBySession: Record<string, SessionRunOptions>;
  defaultPermissionMode: RunPermissionMode;
  draftRunOptions: SessionRunOptions;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcpServers: McpServerInfo[];
  mcpConnectingIds: string[];
  browserStatus?: BrowserSyncStatus;
  runs: RunInfo[];
  artifacts: ArtifactInfo[];
  currentWorkspaceId?: string;
  workspaceLoadingId?: string;
  currentSessionId?: string;
  messagesLoadingSessionId?: string;
  draftWorkspaceId?: string;
  creatingSession: boolean;
  pendingMessage?: string;
  pendingAttachments?: MessageAttachmentInfo[];
  titleGeneratingSessionIds: string[];
  messages: ChatMessage[];
  streaming: string;
  streamingParts: AssistantMessagePart[];
  activeMessageSequence?: number;
  /** Tool calls whose Pi arguments are complete but execution has not started yet. */
  preparedToolCallIds: string[];
  running: boolean;
  activeRunId?: string;
  approvals: PendingApproval[];
  toolCalls: ToolCall[];
  permissionRules: PermissionRuleInfo[];
  workspaceFiles: WorkspaceFileInfo[];
  gitStatus: string;
  gitEntries: WorkspaceGitEntry[];
  gitLoaded: boolean;
  runtimeCapabilities: string[];
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
  runAgent: (message: string, replaceFromMessageId?: string, attachments?: MessageAttachmentInfo[]) => void;
  stopAgent: () => void;
  approve: (id: string) => void;
  reject: (id: string) => void;
  setPermission: (rule: Omit<PermissionRuleInfo, "updatedAt">) => void;
  refreshWorkspace: (id?: string) => void;
  setSelectedModel: (id: string) => void;
  setRunPermissionMode: (mode: RunPermissionMode) => void;
  setDefaultPermissionMode: (mode: RunPermissionMode) => void;
  setRunThinking: (modelId: string, level: RunThinkingLevel) => void;
}

const rid = () => crypto.randomUUID();
let pendingAgentRun: { requestId: string; sessionId: string; userMessageId: string } | undefined;
const handshakeRequests = new Set<string>();
let metadataLookupSupported = false;
const metadataRequests = new Map<string, { resolve: (value: Extract<RuntimeEvent, { type: "model.metadata-resolved" }>["models"]) => void; reject: (error: Error) => void }>();
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

export const useStore = create<AgentState>((set, get) => ({
  connected: false,
  sessionsLoaded: !hasTauriBridge(),
  workspacesLoaded: !hasTauriBridge(),
  lastError: undefined,
  chatRunError: undefined,
  sessions: [],
  workspaces: [],
  modelConfigs: [],
  selectedModelId: undefined,
  runOptionsBySession: loadRunOptions(),
  defaultPermissionMode: loadDefaultPermissionMode(),
  draftRunOptions: {},
  skills: [],
  plugins: [],
  mcpServers: [],
  mcpConnectingIds: [],
  browserStatus: undefined,
  runs: [],
  artifacts: [],
  messages: [],
  messagesLoadingSessionId: undefined,
  streaming: "",
  streamingParts: [],
  activeMessageSequence: undefined,
  preparedToolCallIds: [],
  running: false,
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
    if (cmd.type === "workspace.files" || cmd.type === "workspace.git" || cmd.type === "workspace.gitDiff" || cmd.type === "file.read") workspaceRequests.set(cmd.requestId, cmd.type);
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
      if (cmd.type === "agent.run") {
        if (!cmd.messageId || get().currentSessionId !== cmd.sessionId || pendingAgentRun?.requestId !== cmd.requestId) return false;
        pendingAgentRun = undefined;
        clearDelta();
        set({
          chatRunError: { sessionId: cmd.sessionId, userMessageId: cmd.messageId, detail: String(error) },
          running: false,
          streaming: "",
          streamingParts: [],
          activeMessageSequence: undefined,
          preparedToolCallIds: [],
          activeRunId: undefined,
        });
      } else if (workspaceRequests.delete(cmd.requestId)) {
        set({ lastError: String(error), workspaceError: String(error) });
      } else {
        set({ lastError: String(error) });
      }
      return false;
    });
  },

  newSession: () => {
    const state = get();
    if (state.running) return;
    const workspaceId = state.currentWorkspaceId;
    if (!workspaceId || !state.workspaces.some((workspace) => workspace.id === workspaceId)) {
      set({ lastError: "请先导入项目，再创建会话。" });
      return;
    }
    set({ draftRunOptions: {}, lastError: undefined });
    get().send({ type: "session.create", requestId: rid(), workspaceId });
  },

  newSessionInWorkspace: (workspaceId) => {
    if (get().running || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
    clearDelta();
    set({ currentWorkspaceId: workspaceId, workspaceLoadingId: workspaceId, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined, currentSessionId: undefined, messagesLoadingSessionId: undefined, draftWorkspaceId: workspaceId, draftRunOptions: {}, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], artifacts: [], approvals: [], lastError: undefined, chatRunError: undefined });
    get().refreshWorkspace(workspaceId);
  },

  createSessionForWorkspace: (workspaceId) => {
    if (get().running || get().creatingSession || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
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
    set((state) => state.currentWorkspaceId === id ? {} : { currentWorkspaceId: id, workspaceLoadingId: id, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined });
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
    if (get().running && get().currentSessionId !== id) return;
    clearDelta();
    pendingMessageReplacements.delete(id);
    const workspaceId = get().sessions.find((session) => session.id === id)?.workspaceId;
    const workspaceChanged = workspaceId !== undefined && workspaceId !== get().currentWorkspaceId;
    set({ currentSessionId: id, messagesLoadingSessionId: id, selectedModelId: get().runOptionsBySession[id]?.modelId, currentWorkspaceId: workspaceId ?? get().currentWorkspaceId, ...(workspaceChanged ? { workspaceLoadingId: workspaceId, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined } : {}), draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], artifacts: [], approvals: [], chatRunError: undefined });
    get().send({ type: "session.messages", requestId: rid(), sessionId: id });
    get().send({ type: "session.toolCalls", requestId: rid(), sessionId: id });
    get().send({ type: "session.runs", requestId: rid(), sessionId: id });
    get().send({ type: "artifact.list", requestId: rid(), sessionId: id });
    if (workspaceId) get().refreshWorkspace(workspaceId);
  },

  runAgent: (message, replaceFromMessageId, attachments) => {
    const sid = get().currentSessionId;
    if (!sid) {
      const workspaceId = get().draftWorkspaceId;
      if (!workspaceId || get().creatingSession || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
      set({ pendingMessage: message, pendingAttachments: attachments, currentWorkspaceId: workspaceId, lastError: undefined });
      get().createSessionForWorkspace(workspaceId);
      return;
    }
    const session = get().sessions.find((item) => item.id === sid);
    if (!session?.workspaceId || !get().workspaces.some((workspace) => workspace.id === session.workspaceId)) return;
    if (get().running) return;
    if (!hasTauriBridge()) { set({ lastError: "当前未连接桌面运行时，无法发送消息。" }); return; }
    const history = get().messages;
    const replaceIndex = replaceFromMessageId
      ? history.findIndex((item) => item.id === replaceFromMessageId && item.role === "user")
      : -1;
    if (replaceFromMessageId && replaceIndex < 0) return;
    if (replaceFromMessageId) pendingMessageReplacements.set(sid, replaceFromMessageId);
    const keptMessages = replaceIndex >= 0 ? history.slice(0, replaceIndex) : history;
    const keptRunIds = new Set(keptMessages.flatMap((item) => item.runId ? [item.runId] : []));
    const messageId = rid();
    clearDelta();
    set((s) => ({
      messages: [...keptMessages, { id: messageId, role: "user", content: message, attachments, createdAt: Date.now() }],
      streaming: "",
      streamingParts: [],
      activeMessageSequence: undefined,
      preparedToolCallIds: [],
      running: true,
      creatingSession: false,
      pendingMessage: undefined,
      pendingAttachments: undefined,
      lastError: undefined,
      chatRunError: undefined,
      toolCalls: replaceIndex >= 0 ? s.toolCalls.filter((call) => keptRunIds.has(call.runId)) : s.toolCalls,
      runs: replaceIndex >= 0 ? s.runs.filter((run) => keptRunIds.has(run.id)) : s.runs,
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
    pendingAgentRun = { requestId, sessionId: sid, userMessageId: messageId };
    get().send({ type: "agent.run", requestId, sessionId: sid, message, attachments, messageId, replaceFromMessageId, model, permissionMode: options?.permissionMode ?? get().defaultPermissionMode, thinking });
    if (history.length === 0) {
      get().send({ type: "session.generate-title", requestId: rid(), sessionId: sid, prompt: message || attachments?.map((attachment) => attachment.name).join(", ") || "图片", model });
    }
  },

  stopAgent: () => {
    const runId = get().activeRunId;
    if (!runId) return;
    get().send({ type: "agent.stop", requestId: rid(), runId });
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

// Buffer message deltas and flush at ~30fps so React doesn't rerender per token.
let deltaBuf = "";
let flushTimer: ReturnType<typeof setTimeout> | null = null;
function queueDelta(d: string) {
  deltaBuf += d;
  if (!flushTimer) {
    flushTimer = setTimeout(() => {
      flushTimer = null;
      const chunk = deltaBuf;
      deltaBuf = "";
      useStore.setState((st) => ({ streaming: st.streaming + chunk }));
    }, 32);
  }
}
function flushNow() {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  if (deltaBuf) {
    const chunk = deltaBuf;
    deltaBuf = "";
    useStore.setState((st) => ({ streaming: st.streaming + chunk }));
  }
}

function clearDelta() {
  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = null;
  deltaBuf = "";
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

let wired = false;
let lastSequence = -1;
// A reload removes the selected user turn in the runtime database. Ignore an
// older session.messages response that still contains that turn, otherwise a
// delayed response can restore the old bubble beside the replacement.
const pendingMessageReplacements = new Map<string, string>();
export function initBridge() {
  if (wired) return;
  if (!hasTauriBridge() || typeof listen !== "function" || typeof invoke !== "function") return;
  wired = true;

  const ready = listen<string>("runtime-event", (e) => {
    if (e.payload.includes('"type":"runtime.exited"')) {
      clearDelta();
      metadataLookupSupported = false;
      pendingAgentRun = undefined;
      mcpConnectRequests.clear();
      restoredMcpSecrets.clear();
      for (const request of metadataRequests.values()) request.reject(new Error("Runtime exited"));
      useStore.setState((st) => {
        const userMessage = st.messages.slice().reverse().find((message) => message.role === "user");
        return {
          connected: false,
          browserStatus: st.browserStatus ? { ...st.browserStatus, targetConnected: false, phase: "error", lastError: "浏览器运行时已退出" } : undefined,
          mcpConnectingIds: [],
          githubDeviceAuthorization: undefined,
          running: false,
          activeRunId: undefined,
          approvals: [],
          streaming: "",
          streamingParts: [],
          activeMessageSequence: undefined,
          preparedToolCallIds: [],
          ...(st.running && st.currentSessionId && userMessage ? {
            chatRunError: { sessionId: st.currentSessionId, userMessageId: userMessage.id, detail: "Runtime exited" },
          } : {}),
        };
      });
      invoke("runtime_restart")
        .then(() => useStore.getState().send({ type: "ping", requestId: rid() }))
        .catch((error) => console.error("runtime restart failed", error));
      return;
    }
    let msg: RuntimeEvent;
    try {
      msg = JSON.parse(e.payload);
    } catch {
      return;
    }
    if (msg.type === "model.metadata-resolved") {
      const pending = metadataRequests.get(msg.requestId);
      if (msg.models.every((model) => model.sources && ["contextWindow", "maxTokens", "reasoning", "input", "output"].every((field) => typeof model.sources[field as keyof typeof model.sources] === "string"))) pending?.resolve(msg.models);
      else pending?.reject(new Error("MODEL_METADATA_UNSUPPORTED"));
      return;
    }
    if (msg.type === "error" && msg.requestId && metadataRequests.has(msg.requestId)) {
      metadataRequests.get(msg.requestId)?.reject(new Error(msg.message));
      return;
    }
    const s = useStore.getState();
    switch (msg.type) {
      case "pong":
        if (pendingAgentRun?.requestId === msg.requestId) {
          pendingAgentRun = undefined;
          break;
        }
        if (!handshakeRequests.delete(msg.requestId)) break;
        metadataLookupSupported = Boolean(msg.capabilities?.includes("model.resolve-metadata") && msg.capabilities?.includes("model.metadata-sources"));
        useStore.setState({ connected: true, runtimeCapabilities: msg.capabilities ?? [] });
        s.send({ type: "session.list", requestId: rid() });
        s.send({ type: "workspace.list", requestId: rid() });
        s.send({ type: "model.list", requestId: rid() });
        s.send({ type: "mcp.list", requestId: rid() });
        if (msg.capabilities?.includes("browser.connect")) s.send({ type: "browser.status", requestId: rid() });
        s.send({ type: "permission.list", requestId: rid() });
        s.send({ type: "events.replay", requestId: rid(), sessionId: useStore.getState().currentSessionId, afterSequence: lastSequence });
        break;
      case "session.created":
        clearDelta();
        useStore.setState((st) => ({
          runOptionsBySession: {
            ...st.runOptionsBySession,
            [msg.session.id]: {
              ...(st.runOptionsBySession[msg.session.id] ?? {}),
              ...(st.creatingSession ? st.draftRunOptions : {}),
              ...(!st.runOptionsBySession[msg.session.id]?.modelId && !st.draftRunOptions.modelId && st.selectedModelId ? { modelId: st.selectedModelId } : {}),
            },
          },
          selectedModelId: st.draftRunOptions.modelId ?? st.runOptionsBySession[msg.session.id]?.modelId ?? st.selectedModelId,
          draftRunOptions: {},
          sessions: [msg.session, ...st.sessions],
          currentSessionId: msg.session.id,
          currentWorkspaceId: msg.session.workspaceId ?? st.currentWorkspaceId,
          draftWorkspaceId: undefined,
          messagesLoadingSessionId: undefined,
          messages: [],
          streaming: "",
          streamingParts: [],
          activeMessageSequence: undefined,
          preparedToolCallIds: [],
          toolCalls: [],
          runs: [],
          artifacts: [],
        }));
        saveRunOptions(useStore.getState().runOptionsBySession);
        if (useStore.getState().creatingSession && useStore.getState().pendingMessage !== undefined) {
          queueMicrotask(() => {
            const state = useStore.getState();
            if (state.currentSessionId === msg.session.id && state.pendingMessage !== undefined) state.runAgent(state.pendingMessage, undefined, state.pendingAttachments);
          });
        }
        break;
      case "session.list": {
        const state = useStore.getState();
        const cur = state.currentSessionId;
        const selected = msg.sessions.find((session) => session.id === cur) ?? msg.sessions[0];
        const selectionChanged = selected?.id !== cur;
        if (selectionChanged) clearDelta();
        const storedModelId = selected ? state.runOptionsBySession[selected.id]?.modelId : undefined;
        useStore.setState({
          sessions: msg.sessions,
          sessionsLoaded: true,
          currentSessionId: selected?.id,
          currentWorkspaceId: selected?.workspaceId ?? state.currentWorkspaceId,
          ...(selected?.workspaceId && selected.workspaceId !== state.currentWorkspaceId ? { workspaceLoadingId: selected.workspaceId } : {}),
          selectedModelId: storedModelId,
          ...(selectionChanged ? {
            messages: [],
            messagesLoadingSessionId: selected?.id,
            streaming: "",
            streamingParts: [],
            activeMessageSequence: undefined,
            preparedToolCallIds: [],
            toolCalls: [],
            runs: [],
            artifacts: [],
          } : {}),
        });
        if (selected) {
          s.send({ type: "session.messages", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.toolCalls", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.runs", requestId: rid(), sessionId: selected.id });
          s.send({ type: "artifact.list", requestId: rid(), sessionId: selected.id });
          if (selected.workspaceId) useStore.getState().refreshWorkspace(selected.workspaceId);
        }
        break;
      }
      case "session.renamed":
        useStore.setState((st) => ({
          sessions: st.sessions.map((session) => session.id === msg.session.id ? msg.session : session),
          titleGeneratingSessionIds: st.titleGeneratingSessionIds.filter((id) => id !== msg.session.id),
        }));
        break;
      case "session.messages":
        if (msg.sessionId === useStore.getState().currentSessionId) {
          const replacedMessageId = pendingMessageReplacements.get(msg.sessionId);
          if (replacedMessageId && msg.messages.some((message) => message.id === replacedMessageId)) break;
          if (replacedMessageId) pendingMessageReplacements.delete(msg.sessionId);
          const messages = msg.messages.map((m: MessageInfo) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            parts: m.parts,
            attachments: m.attachments,
            runId: m.runId,
            createdAt: m.createdAt,
          }));
          useStore.setState((st) => ({ messagesLoadingSessionId: undefined, messages, toolCalls: alignToolCallIds(st.toolCalls, messages) }));
        }
        break;
      case "session.toolCalls":
        if (msg.sessionId === useStore.getState().currentSessionId) {
          useStore.setState((st) => {
            const calls = msg.toolCalls.map((t) => ({
                toolCallId: t.id.startsWith(`${t.runId}:`) ? t.id.slice(t.runId.length + 1) : t.id,
                runId: t.runId, toolName: t.toolName,
                status: t.status === "failed" || t.status === "cancelled" ? "failed" : t.status === "running" ? "running" : t.status === "waiting_approval" ? "waiting" : "success",
                args: (() => { try { return t.arguments ? JSON.parse(t.arguments) : undefined; } catch { return undefined; } })(),
                argsText: t.arguments ?? undefined,
                result: (() => { try { return t.resultSummary ? JSON.parse(t.resultSummary) : undefined; } catch { return t.resultSummary; } })(),
                summary: t.resultSummary,
                startedAt: t.startedAt,
                completedAt: t.completedAt,
              } satisfies ToolCall));
            return { toolCalls: alignToolCallIds(calls, st.messages) };
          });
        }
        break;
      case "session.runs":
        if (msg.sessionId === useStore.getState().currentSessionId) {
          const activeRun = msg.runs.find((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status));
          useStore.setState((st) => ({
            runs: msg.runs,
            ...(activeRun && !st.running
              ? { running: true, activeRunId: activeRun.id }
              : !activeRun && st.running && st.activeRunId === undefined
                ? { running: false }
                : {}),
          }));
        }
        break;
      case "artifact.list":
        if (msg.sessionId === useStore.getState().currentSessionId) useStore.setState({ artifacts: msg.artifacts });
        break;
      case "workspace.list": {
        useStore.setState({ workspaces: msg.workspaces, workspacesLoaded: true });
        const current = useStore.getState().currentWorkspaceId;
        const selected = current && msg.workspaces.some((workspace) => workspace.id === current) ? current : msg.workspaces[0]?.id;
        if (selected) {
          useStore.setState({ currentWorkspaceId: selected, workspaceLoadingId: selected, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined });
          useStore.getState().refreshWorkspace(selected);
        }
        break;
      }
      case "workspace.updated":
        clearDelta();
        useStore.setState((st) => ({
          workspaces: [msg.workspace, ...st.workspaces.filter((w) => w.id !== msg.workspace.id)],
          currentWorkspaceId: msg.workspace.id,
          workspaceLoadingId: msg.workspace.id,
          workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined,
        }));
        useStore.getState().refreshWorkspace(msg.workspace.id);
        useStore.setState({ draftWorkspaceId: msg.workspace.id, currentSessionId: undefined, messagesLoadingSessionId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], artifacts: [], approvals: [] });
        break;
      case "workspace.renamed":
        useStore.setState((st) => ({ workspaces: st.workspaces.map((workspace) => workspace.id === msg.workspace.id ? msg.workspace : workspace) }));
        break;
      case "workspace.deleted":
        if (useStore.getState().currentWorkspaceId === msg.workspaceId) clearDelta();
        useStore.setState((st) => {
          const workspaces = st.workspaces.filter((workspace) => workspace.id !== msg.workspaceId);
          const wasCurrent = st.currentWorkspaceId === msg.workspaceId;
          const nextWorkspaceId = wasCurrent ? workspaces[0]?.id : st.currentWorkspaceId;
          return {
            workspaces,
            currentWorkspaceId: nextWorkspaceId,
            ...(wasCurrent ? { currentSessionId: undefined, workspaceLoadingId: nextWorkspaceId, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined, messagesLoadingSessionId: undefined, draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], artifacts: [], approvals: [] } : {}),
          };
        });
        if (useStore.getState().currentWorkspaceId) useStore.getState().refreshWorkspace();
        s.send({ type: "session.list", requestId: rid() });
        break;
      case "workspace.files":
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        if (msg.workspaceId === useStore.getState().currentWorkspaceId) useStore.setState((st) => ({
          workspaceFiles: [
            ...st.workspaceFiles.filter((file) => msg.path
              ? !file.path.startsWith(`${msg.path}/`)
              : !file.path.includes("/")),
            ...msg.files,
          ],
          workspaceLoadingId: undefined,
          workspaceError: undefined,
        }));
        break;
      case "workspace.git":
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        if (msg.workspaceId === useStore.getState().currentWorkspaceId) useStore.setState({ gitStatus: msg.status, gitEntries: msg.entries ?? [], gitLoaded: true, workspaceError: undefined });
        break;
      case "model.list":
        useStore.setState((st) => ({
          modelConfigs: msg.configs,
          selectedModelId: st.selectedModelId ?? (st.currentSessionId ? st.runOptionsBySession[st.currentSessionId]?.modelId : st.draftRunOptions.modelId) ?? msg.configs[0]?.id,
        }));
        for (const config of msg.configs) {
          invoke<string | null>("secret_get", { key: `model.apiKey:${config.provider}` })
            .then((value) => {
              if (value) useStore.getState().send({ type: "secret.set", requestId: rid(), key: `model.apiKey:${config.provider}`, value });
            })
            .catch((error) => console.error("credential restore failed", error));
        }
        break;
      case "model.updated":
        useStore.setState((st) => ({
          modelConfigs: [msg.config, ...st.modelConfigs.filter((c) => c.id !== msg.config.id)],
          selectedModelId: st.selectedModelId ?? msg.config.id,
        }));
        break;
      case "skills.list":
        useStore.setState({ skills: msg.skills });
        break;
      case "plugins.list":
        useStore.setState({ plugins: msg.plugins });
        break;
      case "browser.status":
        useStore.setState({ browserStatus: msg.status });
        break;
      case "mcp.list":
        useStore.setState({ mcpServers: msg.servers });
        for (const server of msg.servers) {
          const oauthKeys = server.authMode === "oauth"
            ? [`mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`]
            : [server.oauth?.tokenSecretKey ?? `mcp.oauth:${server.id}`];
          const keys = [...oauthKeys, ...Object.values(server.env ?? {})
            .filter((value) => value.startsWith("$mcp.env:"))
            .map((value) => value.slice(1))];
          void (async () => {
            for (const key of keys) {
              if (restoredMcpSecrets.has(key)) continue;
              restoredMcpSecrets.add(key);
              try {
                const value = await invoke<string | null>("secret_get", { key });
                if (value) await useStore.getState().send({ type: "secret.set", requestId: rid(), key, value });
              } catch (error) {
                restoredMcpSecrets.delete(key);
                console.error("MCP credential restore failed", error);
              }
            }
          })();
        }
        break;
      case "mcp.connected":
        finishMcpConnection(msg.serverId);
        useStore.setState((st) => ({
          mcpServers: st.mcpServers.map((server) => server.id === msg.serverId ? { ...server, connected: true, toolCount: msg.toolCount } : server),
          githubDeviceAuthorization: st.githubDeviceAuthorization?.serverId === msg.serverId ? undefined : st.githubDeviceAuthorization,
          oauthAuthorization: st.oauthAuthorization?.serverId === msg.serverId ? undefined : st.oauthAuthorization,
        }));
        break;
      case "mcp.oauth.authorization":
        useStore.setState({ oauthAuthorization: { requestId: msg.requestId, serverId: msg.serverId, url: msg.url, state: msg.state } });
        openUrl(msg.url).catch((error) => {
          console.error("OAuth browser launch failed", error);
          useStore.setState({ lastError: String(error) });
          finishMcpConnection(msg.serverId);
        });
        break;
      case "mcp.github.device":
        useStore.setState({ githubDeviceAuthorization: msg });
        if (new URL(msg.verificationUri).hostname === "github.com") openUrl(msg.verificationUri).catch((error) => {
          console.error("GitHub login launch failed", error);
          useStore.setState({ lastError: String(error) });
        });
        break;
      case "mcp.oauth.saved":
        if (msg.key.endsWith(".tokens") || !msg.key.endsWith(".client")) useStore.setState({ oauthAuthorization: undefined });
        break;
      case "mcp.oauth.token":
        useStore.setState({ lastError: "OAuth token was not intercepted by the native credential bridge" });
        break;
      case "permission.list":
        useStore.setState({ permissionRules: msg.rules });
        break;
      case "permission.updated":
        useStore.setState((st) => ({ permissionRules: [msg.rule, ...st.permissionRules.filter((r) => !(r.subjectId === msg.rule.subjectId && r.permission === msg.rule.permission))] }));
        break;
      case "error":
        if (msg.requestId) {
          const serverId = mcpConnectRequests.get(msg.requestId);
          if (serverId) {
            finishMcpConnection(serverId);
            useStore.setState((st) => ({
              githubDeviceAuthorization: st.githubDeviceAuthorization?.serverId === serverId ? undefined : st.githubDeviceAuthorization,
              oauthAuthorization: st.oauthAuthorization?.serverId === serverId ? undefined : st.oauthAuthorization,
            }));
          }
        }
        const workspaceRequest = msg.requestId ? workspaceRequests.get(msg.requestId) : undefined;
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        if (pendingAgentRun && pendingAgentRun.requestId === msg.requestId) {
          const pending = pendingAgentRun;
          pendingAgentRun = undefined;
          if (pending.sessionId === useStore.getState().currentSessionId) {
            clearDelta();
            useStore.setState({
              chatRunError: { sessionId: pending.sessionId, userMessageId: pending.userMessageId, detail: msg.message },
              running: false,
              streaming: "",
              streamingParts: [],
              activeMessageSequence: undefined,
              preparedToolCallIds: [],
              activeRunId: undefined,
            });
          }
          break;
        }
        useStore.setState((st) => ({
          lastError: displayRuntimeError(msg.message),
          ...(workspaceRequest ? { workspaceError: msg.message } : {}),
          ...(st.creatingSession ? { creatingSession: false, pendingMessage: undefined } : {}),
          ...(st.running && !st.activeRunId ? { running: false } : {}),
        }));
        break;
      case "agent.event": {
        const ev = msg.event;
        lastSequence = Math.max(lastSequence, ev.sequence);
        if (ev.sessionId && ev.sessionId !== useStore.getState().currentSessionId) {
          if (["agent.completed", "agent.cancelled", "agent.failed"].includes(ev.type) && ev.runId === useStore.getState().activeRunId) {
            useStore.setState({ running: false, activeRunId: undefined });
          }
          break;
        }
        if (ev.runId && ev.type === "agent.started") {
          useStore.setState((st) => ({
            activeRunId: ev.runId,
            runs: st.runs.some((run) => run.id === ev.runId)
              ? st.runs
              : [{ id: ev.runId!, sessionId: ev.sessionId ?? st.currentSessionId ?? "", status: "running", startedAt: ev.timestamp }, ...st.runs],
          }));
        }
        const p = ev.payload as Record<string, unknown> | undefined;

        if (ev.type === "artifact.created" && p && typeof p.id === "string") {
          useStore.setState((st) => ({ artifacts: [p as never, ...st.artifacts] }));
        }

        if (ev.type === "run.status" && ev.runId && typeof p?.status === "string") {
          useStore.setState((st) => ({ runs: st.runs.map((run) => run.id === ev.runId ? { ...run, status: p.status as RunInfo["status"] } : run) }));
        }

        // Product protocol event; Pi event names never cross into this reducer.
        if (ev.type === "message.started" && ev.runId === useStore.getState().activeRunId && (p?.message as { role?: unknown } | undefined)?.role === "assistant") {
          clearDelta();
          useStore.setState({ activeMessageSequence: ev.sequence, streaming: "" });
        }

        else if (ev.type === "message.block.started" && ev.runId === useStore.getState().activeRunId) {
          flushNow();
          useStore.setState((st) => {
            const messageSequence = st.activeMessageSequence;
            if (messageSequence === undefined) return st;
            const priorText: AssistantMessagePart[] = st.streaming
              ? [{ type: "text", text: st.streaming, messageSequence }]
              : [];
            const newTool: AssistantMessagePart[] = p?.blockType === "tool-call"
              ? [{
                  type: "tool-call",
                  toolCallId: typeof p.toolCallId === "string" && p.toolCallId
                    ? p.toolCallId
                    : `pi-${messageSequence}-${p.contentIndex ?? st.streamingParts.length}`,
                  toolName: String(p.toolName ?? "tool"),
                  args: p.args ?? {},
                  messageSequence,
                }]
              : [];
            return { streaming: "", streamingParts: [...st.streamingParts, ...priorText, ...newTool] };
          });
        }

        else if ((ev.type === "message.block.completed" || ev.type === "message.delta") && ev.runId === useStore.getState().activeRunId && p?.blockType === "tool-call") {
          useStore.setState((st) => {
            const fallbackId = st.activeMessageSequence !== undefined && typeof p.contentIndex === "number"
              ? `pi-${st.activeMessageSequence}-${p.contentIndex}`
              : undefined;
            const toolCallId = typeof p.toolCallId === "string" && p.toolCallId ? p.toolCallId : fallbackId;
            const parts = st.streamingParts.map((part): AssistantMessagePart =>
              part.type === "tool-call" && part.toolCallId === fallbackId && toolCallId
                ? { ...part, toolCallId }
                : part
            );
            if (!toolCallId) return { streamingParts: parts };
            const hasStartedCall = st.toolCalls.some((call) => call.runId === ev.runId && call.toolCallId === toolCallId);
            return {
              streamingParts: applyAssistantToolEvent(parts, "tool.started", { ...p, toolCallId }),
              preparedToolCallIds: ev.type !== "message.block.completed" || hasStartedCall || st.preparedToolCallIds.includes(toolCallId)
                ? st.preparedToolCallIds
                : [...st.preparedToolCallIds, toolCallId],
            };
          });
        }

        else if (ev.type === "message.delta" && ev.runId === useStore.getState().activeRunId && typeof p?.delta === "string") {
          queueDelta(p.delta);
        }

        else if (ev.type === "message.completed" && ev.runId === useStore.getState().activeRunId && (p?.message as { role?: unknown } | undefined)?.role === "assistant") {
          clearDelta();
          useStore.setState((st) => {
            const messageSequence = st.activeMessageSequence ?? ev.sequence;
            const completedParts = assistantPartsFromPiMessage(p, messageSequence);
            const activeToolCallIds = new Set(
              st.toolCalls
                .filter((call) => call.runId === ev.runId)
                .map((call) => call.toolCallId),
            );
            const newlyPrepared = completedParts.flatMap((part) =>
              part.type === "tool-call" && !activeToolCallIds.has(part.toolCallId)
                ? [part.toolCallId]
                : [],
            );
            return {
              streaming: "",
              activeMessageSequence: undefined,
              streamingParts: [
                ...st.streamingParts.filter((part) => part.messageSequence !== messageSequence),
                ...completedParts,
              ],
              preparedToolCallIds: [...new Set([...st.preparedToolCallIds, ...newlyPrepared])],
            };
          });
        }

        else if (ev.type === "tool.started") {
          const toolCallId = typeof p?.toolCallId === "string" && p.toolCallId ? p.toolCallId : rid();
          const toolPayload: Record<string, unknown> & { toolCallId: string } = { ...(p ?? {}), toolCallId };
          const activeRun = ev.runId === useStore.getState().activeRunId;
          if (activeRun) flushNow();
          const tc: ToolCall = {
            toolCallId,
            runId: ev.runId ?? "",
            toolName: String(toolPayload.toolName ?? "tool"),
            status: "running",
            startedAt: ev.timestamp,
            args: toolPayload.input ?? toolPayload.args,
            argsText: (() => {
              const value = toolPayload.input ?? toolPayload.args;
              if (typeof value === "string") return value;
              try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
            })(),
          };
          useStore.setState((st) => {
            const lastPart = st.streamingParts.at(-1);
            const messageSequence = st.activeMessageSequence
              ?? (lastPart?.type === "tool-call" ? lastPart.messageSequence : ev.sequence);
            const existing = st.toolCalls.find((t) => t.toolCallId === toolCallId);
            return {
              toolCalls: existing
                ? st.toolCalls.map((t) => t.toolCallId === toolCallId
                    ? { ...t, ...tc, startedAt: t.startedAt ?? tc.startedAt, completedAt: undefined }
                    : t)
                : [...st.toolCalls, tc],
              preparedToolCallIds: st.preparedToolCallIds.filter((id) => id !== toolCallId),
              ...(ev.runId === st.activeRunId ? {
                streaming: "",
                streamingParts: ensureStreamingToolPart(
                  st.streaming
                    ? [...st.streamingParts, { type: "text", text: st.streaming, messageSequence: st.activeMessageSequence ?? ev.sequence }]
                    : st.streamingParts,
                  toolPayload,
                  messageSequence,
                ),
              } : {}),
            };
          });
        } else if (ev.type === "tool.updated" && ev.runId === useStore.getState().activeRunId) {
          useStore.setState((st) => ({
            toolCalls: st.toolCalls.map((call) =>
              call.runId === ev.runId && call.toolCallId === p?.toolCallId && (call.status === "running" || call.status === "waiting")
                ? { ...call, status: "running", result: p.update }
                : call
            ),
          }));
        } else if (ev.type === "tool.completed" || ev.type === "tool.failed") {
          const id = String(p?.toolCallId ?? "");
          const isErr = ev.type === "tool.failed" || Boolean(p?.isError ?? p?.error);
          useStore.setState((st) => ({
            toolCalls: st.toolCalls.map((t) =>
              t.toolCallId === id
                ? {
                    ...t,
                    status: isErr ? "failed" : "success",
                    result: p?.content ?? p?.result,
                    summary: JSON.stringify(p?.content ?? p?.result ?? "").slice(0, 20_000),
                    completedAt: ev.timestamp,
                  }
                : t
            ),
            preparedToolCallIds: st.preparedToolCallIds.filter((preparedId) => preparedId !== id),
            streamingParts: ev.runId === st.activeRunId
              ? applyAssistantToolEvent(st.streamingParts, ev.type === "tool.failed" ? "tool.failed" : "tool.completed", p)
              : st.streamingParts,
          }));
        }

        // Approval requests from the permission layer
        else if (ev.type === "approval.requested") {
          if (ev.runId) {
            useStore.setState((st) => ({ runs: st.runs.map((run) => run.id === ev.runId ? { ...run, status: "waiting_approval" } : run) }));
          }
          useStore.setState((st) => ({
            toolCalls: st.toolCalls.map((tool) => tool.toolName === String(p?.toolName ?? "") && tool.status === "running" ? { ...tool, status: "waiting" } : tool),
            approvals: [
              ...st.approvals,
              {
                id: String(p?.approvalId ?? ""),
                toolName: String(p?.toolName ?? "tool"),
                args: p?.args,
              },
            ],
          }));
        }

        else if (
          ev.type === "agent.completed" ||
          ev.type === "agent.cancelled" ||
          ev.type === "agent.failed"
        ) {
          const isActiveRun = !ev.runId || ev.runId === useStore.getState().activeRunId;
          if (isActiveRun) clearDelta();
          const completedMessage = p?.message;
          if (
            completedMessage &&
            typeof completedMessage === "object" &&
            typeof (completedMessage as { id?: unknown }).id === "string" &&
            typeof (completedMessage as { content?: unknown }).content === "string"
          ) {
            const message = completedMessage as { id: string; role?: string; content: string; parts?: AssistantMessagePart[]; runId?: string; createdAt?: number };
            useStore.setState((st) => ({
              messages: st.messages.some((item) => item.id === message.id)
                ? st.messages
                : [...st.messages, {
                    id: message.id,
                    role: message.role ?? "assistant",
                    content: message.content,
                    parts: message.parts,
                    runId: message.runId,
                    createdAt: message.createdAt,
                  }],
            }));
          }
          if (ev.type === "agent.failed" && isActiveRun) {
            useStore.setState((st) => {
              const userMessage = st.messages.slice().reverse().find((message) => message.role === "user");
              return userMessage && st.currentSessionId ? {
                chatRunError: {
                  sessionId: st.currentSessionId,
                  userMessageId: userMessage.id,
                  detail: typeof p?.message === "string" ? p.message : "",
                },
              } : { lastError: typeof p?.message === "string" ? p.message : "Agent failed" };
            });
          }
          if (ev.runId) {
            const status = ev.type === "agent.completed" ? "completed" : ev.type === "agent.cancelled" ? "cancelled" : "failed";
            useStore.setState((st) => ({ runs: st.runs.map((run) => run.id === ev.runId ? { ...run, status, completedAt: Date.now() } : run) }));
          }
          if (isActiveRun) {
            useStore.setState({ streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], running: false, activeRunId: undefined, approvals: [] });
          }
          const sessionId = ev.sessionId ?? useStore.getState().currentSessionId;
          if (sessionId) {
            const state = useStore.getState();
            state.send({ type: "session.messages", requestId: rid(), sessionId });
            state.send({ type: "session.toolCalls", requestId: rid(), sessionId });
            state.send({ type: "session.runs", requestId: rid(), sessionId });
            state.send({ type: "artifact.list", requestId: rid(), sessionId });
          }
        }
        break;
      }
      case "file.read":
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        useStore.setState({ openFile: { workspaceId: msg.workspaceId, path: msg.path, content: msg.content }, workspaceError: undefined });
        break;
      case "workspace.gitDiff":
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        useStore.setState({ gitDiffView: { workspaceId: msg.workspaceId, path: msg.path, diff: msg.diff }, workspaceError: undefined });
        break;
      case "events.replay":
        for (const ev of msg.events) {
          lastSequence = Math.max(lastSequence, ev.sequence);
          // Feed replayed events through the same reducer on the next reconnect.
          // Current UI state is intentionally not rebuilt from stale tool cards;
          // persisted messages/runs are authoritative and are loaded above.
        }
        break;
    }
  });
  void ready
    .then(() => useStore.getState().send({ type: "ping", requestId: rid() }))
    .catch((error) => {
      wired = false;
      console.error("runtime listener setup failed", error);
    });
}
