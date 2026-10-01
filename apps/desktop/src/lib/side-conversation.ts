import { parseMcpCommand, type QueueItemInfo, type RuntimeCommand, type RuntimeEvent, type SessionInfo } from "@qone/protocol";
import { useStore } from "../store";
import { saveRunOptions, type SessionRunOptions } from "./run-options";
import { emptySessionState } from "./session-execution-state";
import { getQoneMessageQueue } from "./qone-message-queue";
import { bindSessionQueue } from "./session-queue-lifecycle";
import { composerDrafts } from "./composer-drafts";
import { translateCurrent as t } from "../localization";
import { extractComposerPrompt } from "./composer-prompt";

type Pending = {
  command: Extract<RuntimeCommand, { type: "session.side-chat.create" }>;
  options: SessionRunOptions;
  resolve: (committed: boolean) => void;
  reject: (error: Error) => void;
};
const requests = new Map<string, Pending>();
const closes = new Map<string, { session: SessionInfo; resolve: (closed: boolean) => void; reject: (error: Error) => void }>();

export function openQueuedSideConversation(item: QueueItemInfo): Promise<boolean> {
  const state = useStore.getState();
  if (!state.connected) return Promise.reject(new Error(t("error.runtimeDisconnected")));
  const queue = getQoneMessageQueue(item.sessionId);
  const localId = queue?.getLocalId(item.id);
  const message = localId && queue?.getMessage(localId);
  const prompt = message ? extractComposerPrompt(message) : { text: item.text, goal: false };
  const mcp = parseMcpCommand(prompt.text);
  if (mcp) {
    const server = state.mcpServers.find((candidate) => candidate.id === mcp.serverId);
    if (!server?.connected || !server.toolCount) return Promise.reject(new Error(t("error.mcpUnavailable")));
    if (!mcp.text && !item.attachments?.length) return Promise.reject(new Error(t("error.mcpMessageRequired")));
    if (prompt.goal) return Promise.reject(new Error(t("error.goalMcpUnsupported")));
  }
  const requestId = crypto.randomUUID();
  const command: Pending["command"] = { type: "session.side-chat.create", requestId, sessionId: item.sessionId, queueItemId: item.id };
  return new Promise((resolve, reject) => {
    requests.set(requestId, {
      command, resolve, reject,
      options: { ...state.runOptionsBySession[item.sessionId], modelId: state.runOptionsBySession[item.sessionId]?.modelId ?? state.selectedModelId,
        permissionMode: state.runOptionsBySession[item.sessionId]?.permissionMode ?? state.defaultPermissionMode },
    });
    useStore.setState((current) => ({ sideChatTransfers: { ...current.sideChatTransfers, [requestId]: item } }));
    // An IPC error can arrive after the runtime committed. Keep ownership
    // pending; reconnect retries the same idempotent transfer, never the input.
    void state.send(command).then((sent) => {
      if (!sent) void useStore.getState().send({ type: "ping", requestId: crypto.randomUUID() });
    });
  });
}

export function retrySideConversationTransfers() {
  for (const { command } of requests.values()) {
    void useStore.getState().send(command);
    const queue = getQoneMessageQueue(command.sessionId);
    if (queue) bindSessionQueue(command.sessionId, queue);
  }
  for (const session of Object.values(useStore.getState().sideChats)) {
    const send = useStore.getState().send;
    void send({ type: "session.messages", requestId: crypto.randomUUID(), sessionId: session.id });
    void send({ type: "session.queue.list", requestId: crypto.randomUUID(), sessionId: session.id });
    void send({ type: "session.runs", requestId: crypto.randomUUID(), sessionId: session.id });
  }
  for (const [requestId, { session }] of closes) void useStore.getState().send({ type: "session.delete", requestId, sessionId: session.id });
}

export function handleSideConversationEvent(event: RuntimeEvent): boolean {
  if ((event.type === "pong" || event.type === "error") && event.requestId && closes.has(event.requestId)) {
    const pending = closes.get(event.requestId)!;
    closes.delete(event.requestId);
    if (event.type === "error") pending.reject(new Error(event.message));
    else { discardSideConversation(pending.session); pending.resolve(true); }
    return true;
  }
  if (event.type !== "session.side-chat.created" && event.type !== "error") return false;
  const requestId = event.requestId;
  const pending = requestId && requests.get(requestId);
  if (!pending) return false;
  requests.delete(requestId!);
  useStore.setState((state) => {
    const sideChatTransfers = { ...state.sideChatTransfers };
    delete sideChatTransfers[requestId!];
    if (event.type === "error") return { sideChatTransfers };
    const session = event.session;
    const runOptionsBySession = { ...state.runOptionsBySession, [session.id]: pending.options };
    saveRunOptions(runOptionsBySession);
    return {
      sideChatTransfers, runOptionsBySession,
      sideChats: { ...state.sideChats, [session.id]: session },
      backgroundSessions: { ...state.backgroundSessions, [session.id]: { ...emptySessionState(), ...state.backgroundSessions[session.id] } },
    };
  });
  if (event.type === "error") pending.reject(new Error(event.message));
  else pending.resolve(true);
  return true;
}

function discardSideConversation(session: SessionInfo) {
  getQoneMessageQueue(session.id)?.suspend();
  composerDrafts.set(session.id, { text: "", attachments: [], quote: undefined });
  useStore.setState((current) => {
    const sideChats = { ...current.sideChats };
    const backgroundSessions = { ...current.backgroundSessions };
    const runOptionsBySession = { ...current.runOptionsBySession };
    delete sideChats[session.id]; delete backgroundSessions[session.id]; delete runOptionsBySession[session.id];
    saveRunOptions(runOptionsBySession);
    return { sideChats, backgroundSessions, runOptionsBySession, runningSessionIds: current.runningSessionIds.filter((id) => id !== session.id) };
  });
}

export function closeSideConversation(session: SessionInfo): Promise<boolean> {
  const requestId = crypto.randomUUID();
  return new Promise((resolve, reject) => {
    closes.set(requestId, { session, resolve, reject });
    void useStore.getState().send({ type: "session.delete", requestId, sessionId: session.id }).then((sent) => {
      if (!sent) void useStore.getState().send({ type: "ping", requestId: crypto.randomUUID() });
    });
  });
}
