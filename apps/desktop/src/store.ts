import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RuntimeCommand, RuntimeEvent, SessionInfo, MessageInfo, MessageAttachmentInfo, WorkspaceInfo, WorkspaceFileInfo, ModelConfigInfo, SkillInfo, PluginInfo, McpServerInfo, RunInfo, ArtifactInfo, PermissionRuleInfo, RunPermissionMode, RunThinkingLevel } from "@qone/protocol";
import { loadRunOptions, saveRunOptions, type SessionRunOptions } from "./lib/run-options";

export function hasTauriBridge() {
  return typeof window !== "undefined" && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
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
  draftRunOptions: SessionRunOptions;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcpServers: McpServerInfo[];
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
  running: boolean;
  activeRunId?: string;
  approvals: PendingApproval[];
  toolCalls: ToolCall[];
  permissionRules: PermissionRuleInfo[];
  workspaceFiles: WorkspaceFileInfo[];
  gitStatus: string;
  pinnedWorkspaceIds: string[];
  oauthAuthorization?: { requestId: string; serverId: string; url: string; state: string };
  send: (cmd: RuntimeCommand) => void;
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
  setRunThinking: (modelId: string, level: RunThinkingLevel) => void;
}

const rid = () => crypto.randomUUID();
let pendingAgentRun: { requestId: string; sessionId: string; userMessageId: string } | undefined;
const handshakeRequests = new Set<string>();
let metadataLookupSupported = false;
const metadataRequests = new Map<string, { resolve: (value: Extract<RuntimeEvent, { type: "model.metadata-resolved" }>["models"]) => void; reject: (error: Error) => void }>();

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
  draftRunOptions: {},
  skills: [],
  plugins: [],
  mcpServers: [],
  runs: [],
  artifacts: [],
  messages: [],
  messagesLoadingSessionId: undefined,
  streaming: "",
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
  pinnedWorkspaceIds: (() => {
    try {
      const raw = window.localStorage.getItem("qone-pinned-workspaces");
      const parsed = raw ? JSON.parse(raw) : [];
      return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
    } catch { return []; }
  })(),

  send: (cmd) => {
    // Browser previews do not expose Tauri's invoke bridge.
    if (!hasTauriBridge()) return;
    if (cmd.type === "ping") handshakeRequests.add(cmd.requestId);
    invoke("runtime_send", { cmd: JSON.stringify(cmd) }).catch((error) => {
      console.error("runtime_send failed", error);
      if (cmd.type === "agent.run") {
        if (!cmd.messageId || get().currentSessionId !== cmd.sessionId || pendingAgentRun?.requestId !== cmd.requestId) return;
        pendingAgentRun = undefined;
        set({
          chatRunError: { sessionId: cmd.sessionId, userMessageId: cmd.messageId, detail: String(error) },
          running: false,
          streaming: "",
          activeRunId: undefined,
        });
      } else {
        set({ lastError: String(error) });
      }
    });
  },

  newSession: () => {
    set({ draftRunOptions: {} });
    get().send({ type: "session.create", requestId: rid(), workspaceId: get().currentWorkspaceId });
  },

  newSessionInWorkspace: (workspaceId) => {
    if (get().running || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
    set({ currentWorkspaceId: workspaceId, workspaceLoadingId: workspaceId, currentSessionId: undefined, messagesLoadingSessionId: undefined, draftWorkspaceId: workspaceId, draftRunOptions: {}, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [], lastError: undefined, chatRunError: undefined });
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
    set((state) => ({ currentWorkspaceId: id, ...(state.currentWorkspaceId === id ? {} : { workspaceLoadingId: id }) }));
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
    pendingMessageReplacements.delete(id);
    const workspaceId = get().sessions.find((session) => session.id === id)?.workspaceId;
    const workspaceChanged = workspaceId !== undefined && workspaceId !== get().currentWorkspaceId;
    set({ currentSessionId: id, messagesLoadingSessionId: id, selectedModelId: get().runOptionsBySession[id]?.modelId, currentWorkspaceId: workspaceId ?? get().currentWorkspaceId, ...(workspaceChanged ? { workspaceLoadingId: workspaceId } : {}), draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [], chatRunError: undefined });
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
    set((s) => ({
      messages: [...keptMessages, { id: messageId, role: "user", content: message, attachments, createdAt: Date.now() }],
      streaming: "",
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
    const requestId = rid();
    pendingAgentRun = { requestId, sessionId: sid, userMessageId: messageId };
    get().send({ type: "agent.run", requestId, sessionId: sid, message, attachments, messageId, replaceFromMessageId, model, permissionMode: options?.permissionMode ?? "ask", thinking: model ? options?.thinkingByModel?.[model] : undefined });
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
      metadataLookupSupported = false;
      pendingAgentRun = undefined;
      for (const request of metadataRequests.values()) request.reject(new Error("Runtime exited"));
      useStore.setState((st) => {
        const userMessage = st.messages.slice().reverse().find((message) => message.role === "user");
        return {
          connected: false,
          running: false,
          activeRunId: undefined,
          approvals: [],
          streaming: "",
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
        useStore.setState({ connected: true });
        s.send({ type: "session.list", requestId: rid() });
        s.send({ type: "workspace.list", requestId: rid() });
        s.send({ type: "model.list", requestId: rid() });
        s.send({ type: "permission.list", requestId: rid() });
        s.send({ type: "events.replay", requestId: rid(), sessionId: useStore.getState().currentSessionId, afterSequence: lastSequence });
        break;
      case "session.created":
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
          useStore.setState({ messagesLoadingSessionId: undefined, messages: msg.messages.map((m: MessageInfo) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            attachments: m.attachments,
            runId: m.runId,
            createdAt: m.createdAt,
          })) });
        }
        break;
      case "session.toolCalls":
        if (msg.sessionId === useStore.getState().currentSessionId) {
          useStore.setState({ toolCalls: msg.toolCalls.map((t) => ({
            toolCallId: t.id, runId: t.runId, toolName: t.toolName,
            status: t.status === "failed" || t.status === "cancelled" ? "failed" : t.status === "running" ? "running" : t.status === "waiting_approval" ? "waiting" : "success",
            args: (() => { try { return t.arguments ? JSON.parse(t.arguments) : undefined; } catch { return undefined; } })(),
            argsText: t.arguments ?? undefined,
            result: (() => { try { return t.resultSummary ? JSON.parse(t.resultSummary) : undefined; } catch { return t.resultSummary; } })(),
            summary: t.resultSummary,
            startedAt: t.startedAt,
            completedAt: t.completedAt,
          })) });
        }
        break;
      case "session.runs":
        if (msg.sessionId === useStore.getState().currentSessionId) useStore.setState({ runs: msg.runs });
        break;
      case "artifact.list":
        if (msg.sessionId === useStore.getState().currentSessionId) useStore.setState({ artifacts: msg.artifacts });
        break;
      case "workspace.list": {
        useStore.setState({ workspaces: msg.workspaces, workspacesLoaded: true });
        const current = useStore.getState().currentWorkspaceId;
        const selected = current && msg.workspaces.some((workspace) => workspace.id === current) ? current : msg.workspaces[0]?.id;
        if (selected) {
          useStore.setState({ currentWorkspaceId: selected, workspaceLoadingId: selected });
          useStore.getState().refreshWorkspace(selected);
        }
        break;
      }
      case "workspace.updated":
        useStore.setState((st) => ({
          workspaces: [msg.workspace, ...st.workspaces.filter((w) => w.id !== msg.workspace.id)],
          currentWorkspaceId: msg.workspace.id,
          workspaceLoadingId: msg.workspace.id,
        }));
        useStore.getState().refreshWorkspace(msg.workspace.id);
        useStore.setState({ draftWorkspaceId: msg.workspace.id, currentSessionId: undefined, messagesLoadingSessionId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [] });
        break;
      case "workspace.renamed":
        useStore.setState((st) => ({ workspaces: st.workspaces.map((workspace) => workspace.id === msg.workspace.id ? msg.workspace : workspace) }));
        break;
      case "workspace.deleted":
        useStore.setState((st) => {
          const workspaces = st.workspaces.filter((workspace) => workspace.id !== msg.workspaceId);
          const wasCurrent = st.currentWorkspaceId === msg.workspaceId;
          const nextWorkspaceId = wasCurrent ? workspaces[0]?.id : st.currentWorkspaceId;
          return {
            workspaces,
            currentWorkspaceId: nextWorkspaceId,
            ...(wasCurrent ? { currentSessionId: undefined, workspaceLoadingId: nextWorkspaceId, messagesLoadingSessionId: undefined, draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [] } : {}),
          };
        });
        if (useStore.getState().currentWorkspaceId) useStore.getState().refreshWorkspace();
        break;
      case "workspace.files":
        if (msg.workspaceId === useStore.getState().currentWorkspaceId) useStore.setState({ workspaceFiles: msg.files, workspaceLoadingId: undefined });
        break;
      case "workspace.git":
        if (msg.workspaceId === useStore.getState().currentWorkspaceId) useStore.setState({ gitStatus: msg.status });
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
      case "mcp.list":
        useStore.setState({ mcpServers: msg.servers });
        for (const server of msg.servers) {
          const key = server.oauth?.tokenSecretKey ?? (server.oauth ? `mcp.oauth:${server.id}` : undefined);
          if (key) invoke<string | null>("secret_get", { key }).then((value) => {
            if (value) useStore.getState().send({ type: "secret.set", requestId: rid(), key, value });
          }).catch(() => {});
        }
        break;
      case "mcp.oauth.authorization":
        useStore.setState({ oauthAuthorization: { requestId: msg.requestId, serverId: msg.serverId, url: msg.url, state: msg.state } });
        openUrl(msg.url).catch((error) => console.error("OAuth browser launch failed", error));
        break;
      case "mcp.oauth.saved":
        useStore.setState({ oauthAuthorization: undefined });
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
        if (pendingAgentRun && pendingAgentRun.requestId === msg.requestId) {
          const pending = pendingAgentRun;
          pendingAgentRun = undefined;
          if (pending.sessionId === useStore.getState().currentSessionId) {
            useStore.setState({
              chatRunError: { sessionId: pending.sessionId, userMessageId: pending.userMessageId, detail: msg.message },
              running: false,
              streaming: "",
              activeRunId: undefined,
            });
          }
          break;
        }
        useStore.setState((st) => ({
          lastError: msg.message,
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
        if (ev.type === "message.delta" && typeof p?.delta === "string") {
          queueDelta(p.delta);
        }

        else if (ev.type === "tool.started") {
          const tc: ToolCall = {
            toolCallId: String(p?.toolCallId ?? rid()),
            runId: ev.runId ?? "",
            toolName: String(p?.toolName ?? "tool"),
            status: "running",
            args: p?.input ?? p?.args,
            argsText: (() => {
              const value = p?.input ?? p?.args;
              if (typeof value === "string") return value;
              try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
            })(),
          };
          useStore.setState((st) => ({ toolCalls: [...st.toolCalls, tc] }));
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
          if (ev.runId && ev.runId !== useStore.getState().activeRunId) break;
          flushNow();
          const completedMessage = p?.message;
          if (
            ev.type === "agent.completed" &&
            completedMessage &&
            typeof completedMessage === "object" &&
            typeof (completedMessage as { id?: unknown }).id === "string" &&
            typeof (completedMessage as { content?: unknown }).content === "string"
          ) {
            const message = completedMessage as { id: string; role?: string; content: string; runId?: string; createdAt?: number };
            useStore.setState((st) => ({
              messages: st.messages.some((item) => item.id === message.id)
                ? st.messages
                : [...st.messages, {
                    id: message.id,
                    role: message.role ?? "assistant",
                    content: message.content,
                    runId: message.runId,
                    createdAt: message.createdAt,
                  }],
            }));
          }
          if (ev.type === "agent.failed") {
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
          useStore.setState({ streaming: "", running: false, activeRunId: undefined, approvals: [] });
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
