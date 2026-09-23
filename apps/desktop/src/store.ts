import { create } from "zustand";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { RuntimeCommand, RuntimeEvent, SessionInfo, MessageInfo, WorkspaceInfo, WorkspaceFileInfo, ModelConfigInfo, SkillInfo, PluginInfo, McpServerInfo, RunInfo, ArtifactInfo, PermissionRuleInfo } from "@qone/protocol";

export function hasTauriBridge() {
  return typeof window !== "undefined" && Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

export interface ChatMessage {
  id: string;
  role: string;
  content: string;
  runId?: string;
  createdAt?: number;
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
  lastError?: string;
  sessions: SessionInfo[];
  workspaces: WorkspaceInfo[];
  modelConfigs: ModelConfigInfo[];
  selectedModelId?: string;
  skills: SkillInfo[];
  plugins: PluginInfo[];
  mcpServers: McpServerInfo[];
  runs: RunInfo[];
  artifacts: ArtifactInfo[];
  currentWorkspaceId?: string;
  currentSessionId?: string;
  draftWorkspaceId?: string;
  creatingSession: boolean;
  pendingMessage?: string;
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
  runAgent: (message: string) => void;
  stopAgent: () => void;
  approve: (id: string) => void;
  reject: (id: string) => void;
  setPermission: (rule: Omit<PermissionRuleInfo, "updatedAt">) => void;
  refreshWorkspace: (id?: string) => void;
  setSelectedModel: (id: string) => void;
}

const rid = () => crypto.randomUUID();
const handshakeRequests = new Set<string>();

export const useStore = create<AgentState>((set, get) => ({
  connected: false,
  lastError: undefined,
  sessions: [],
  workspaces: [],
  modelConfigs: [],
  selectedModelId: undefined,
  skills: [],
  plugins: [],
  mcpServers: [],
  runs: [],
  artifacts: [],
  messages: [],
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
      set({ lastError: String(error), ...(cmd.type === "agent.run" ? { running: false } : {}) });
    });
  },

  newSession: () => {
    get().send({ type: "session.create", requestId: rid(), workspaceId: get().currentWorkspaceId });
  },

  newSessionInWorkspace: (workspaceId) => {
    if (get().running || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
    set({ currentWorkspaceId: workspaceId, currentSessionId: undefined, draftWorkspaceId: workspaceId, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [], lastError: undefined });
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
    set({ currentWorkspaceId: id });
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
    const workspaceId = get().sessions.find((session) => session.id === id)?.workspaceId;
    set({ currentSessionId: id, currentWorkspaceId: workspaceId ?? get().currentWorkspaceId, draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [] });
    get().send({ type: "session.messages", requestId: rid(), sessionId: id });
    get().send({ type: "session.toolCalls", requestId: rid(), sessionId: id });
    get().send({ type: "session.runs", requestId: rid(), sessionId: id });
    get().send({ type: "artifact.list", requestId: rid(), sessionId: id });
    if (workspaceId) get().refreshWorkspace(workspaceId);
  },

  runAgent: (message) => {
    const sid = get().currentSessionId;
    if (!sid) {
      const workspaceId = get().draftWorkspaceId;
      if (!workspaceId || get().creatingSession || !get().workspaces.some((workspace) => workspace.id === workspaceId)) return;
      set({ pendingMessage: message, currentWorkspaceId: workspaceId, lastError: undefined });
      get().createSessionForWorkspace(workspaceId);
      return;
    }
    const session = get().sessions.find((item) => item.id === sid);
    if (!session?.workspaceId || !get().workspaces.some((workspace) => workspace.id === session.workspaceId)) return;
    if (get().running) return;
    if (!hasTauriBridge()) { set({ lastError: "当前未连接桌面运行时，无法发送消息。" }); return; }
    const messageId = rid();
    set((s) => ({
      messages: [...s.messages, { id: messageId, role: "user", content: message }],
      streaming: "",
      running: true,
      creatingSession: false,
      pendingMessage: undefined,
      lastError: undefined,
      toolCalls: [],
      titleGeneratingSessionIds: s.messages.length === 0 && !s.titleGeneratingSessionIds.includes(sid)
        ? [...s.titleGeneratingSessionIds, sid]
        : s.titleGeneratingSessionIds,
    }));
    get().send({ type: "agent.run", requestId: rid(), sessionId: sid, message, messageId, model: get().selectedModelId });
    if (get().messages.length === 1) {
      get().send({ type: "session.generate-title", requestId: rid(), sessionId: sid, prompt: message, model: get().selectedModelId });
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

  setSelectedModel: (id) => set({ selectedModelId: id }),
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
export function initBridge() {
  if (wired) return;
  if (!hasTauriBridge() || typeof listen !== "function" || typeof invoke !== "function") return;
  wired = true;

  const ready = listen<string>("runtime-event", (e) => {
    if (e.payload.includes('"type":"runtime.exited"')) {
      useStore.setState({ connected: false, running: false, activeRunId: undefined, approvals: [], streaming: "" });
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
    const s = useStore.getState();
    switch (msg.type) {
      case "pong":
        if (!handshakeRequests.delete(msg.requestId)) break;
        useStore.setState({ connected: true });
        s.send({ type: "session.list", requestId: rid() });
        s.send({ type: "workspace.list", requestId: rid() });
        s.send({ type: "model.list", requestId: rid() });
        s.send({ type: "permission.list", requestId: rid() });
        s.send({ type: "events.replay", requestId: rid(), sessionId: useStore.getState().currentSessionId, afterSequence: lastSequence });
        break;
      case "session.created":
        useStore.setState((st) => ({
          sessions: [msg.session, ...st.sessions],
          currentSessionId: msg.session.id,
          currentWorkspaceId: msg.session.workspaceId ?? st.currentWorkspaceId,
          draftWorkspaceId: undefined,
          messages: [],
          streaming: "",
          toolCalls: [],
          runs: [],
          artifacts: [],
        }));
        if (useStore.getState().creatingSession && useStore.getState().pendingMessage) {
          queueMicrotask(() => {
            const state = useStore.getState();
            if (state.currentSessionId === msg.session.id && state.pendingMessage) state.runAgent(state.pendingMessage);
          });
        }
        break;
      case "session.list": {
        const cur = useStore.getState().currentSessionId;
        const selected = msg.sessions.find((session) => session.id === cur) ?? msg.sessions[0];
        useStore.setState({
          sessions: msg.sessions,
          currentSessionId: selected?.id,
          currentWorkspaceId: selected?.workspaceId ?? useStore.getState().currentWorkspaceId,
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
          useStore.setState({ messages: msg.messages.map((m: MessageInfo) => ({
            id: m.id,
            role: m.role,
            content: m.content,
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
        useStore.setState({ workspaces: msg.workspaces });
        const current = useStore.getState().currentWorkspaceId;
        const selected = current && msg.workspaces.some((workspace) => workspace.id === current) ? current : msg.workspaces[0]?.id;
        if (selected) {
          useStore.setState({ currentWorkspaceId: selected });
          useStore.getState().refreshWorkspace(selected);
        }
        break;
      }
      case "workspace.updated":
        useStore.setState((st) => ({
          workspaces: [msg.workspace, ...st.workspaces.filter((w) => w.id !== msg.workspace.id)],
          currentWorkspaceId: msg.workspace.id,
        }));
        useStore.getState().refreshWorkspace(msg.workspace.id);
        useStore.setState({ draftWorkspaceId: msg.workspace.id, currentSessionId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [] });
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
            ...(wasCurrent ? { currentSessionId: undefined, draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], streaming: "", toolCalls: [], runs: [], artifacts: [], approvals: [] } : {}),
          };
        });
        if (useStore.getState().currentWorkspaceId) useStore.getState().refreshWorkspace();
        break;
      case "workspace.files":
        if (msg.workspaceId === useStore.getState().currentWorkspaceId) useStore.setState({ workspaceFiles: msg.files });
        break;
      case "workspace.git":
        if (msg.workspaceId === useStore.getState().currentWorkspaceId) useStore.setState({ gitStatus: msg.status });
        break;
      case "model.list":
        useStore.setState((st) => ({
          modelConfigs: msg.configs,
          selectedModelId: st.selectedModelId && msg.configs.some((config) => config.id === st.selectedModelId)
            ? st.selectedModelId
            : msg.configs[0]?.id,
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
          if (ev.type === "agent.failed" && typeof p?.message === "string") {
            useStore.setState({ lastError: p.message });
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
