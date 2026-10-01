import { afterAll, expect, mock, test } from "bun:test";
import type { RuntimeCommand, RuntimeEvent, SessionInfo } from "@qone/protocol";

const commands: RuntimeCommand[] = [];
let listener: ((event: { payload: string }) => void) | undefined;
mock.module("@tauri-apps/api/core", () => ({ invoke: async (name: string, args?: { cmd?: string }) => {
  if (name === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
} }));
mock.module("@tauri-apps/api/event", () => ({ listen: async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; } }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const storage = new Map<string, string>();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {}, localStorage: {
  getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value),
} } });
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });

const { useStore, initBridge } = await import("../src/store");
const { openQueuedSideConversation, closeSideConversation, retrySideConversationTransfers } = await import("../src/lib/side-conversation");
const { emptySessionState, switchSessionState } = await import("../src/lib/session-execution-state");
const { loadFollowUpQueueMode } = await import("../src/lib/run-options");
initBridge(); await Promise.resolve();
const emit = (event: RuntimeEvent) => listener?.({ payload: JSON.stringify(event) });
const parent: SessionInfo = { id: "parent", title: "parent", workspaceId: "workspace", createdAt: 1, updatedAt: 1 };
const other = { ...parent, id: "other" };
const side = { ...parent, id: "side", sideChat: { parentSessionId: parent.id, boundaryMessageId: "boundary" } };
const input = { id: "queue-input", sessionId: parent.id, text: "side input", lane: "queue" as const, status: "queued" as const, position: 0, createdAt: 1, updatedAt: 1 };
function seed() {
  commands.length = 0;
  useStore.setState({ ...emptySessionState(), currentSessionId: parent.id, sessions: [parent, other], sessionsLoaded: true, connected: true,
    workspaces: [{ id: "workspace", name: "project", path: "C:\\repo", createdAt: 1, updatedAt: 1 }],
    running: true, activeRunId: "parent-run", runningSessionIds: [parent.id],
    messages: [{ id: "old", role: "user", content: "main input" }], backgroundSessions: {}, sideChats: {}, sideChatTransfers: {},
    selectedModelId: "test/model", runOptionsBySession: { [parent.id]: { modelId: "test/model", permissionMode: "full", thinkingByModel: { "test/model": "high" } } },
  });
}

test("a late side-chat response preserves the selected chat, parent run and parent's input", async () => {
  const previous = useStore.getState();
  try {
    seed(); const creation = openQueuedSideConversation(input);
    const command = commands.find((item) => item.type === "session.side-chat.create")!;
    useStore.setState({ ...switchSessionState(useStore.getState(), other.id), currentSessionId: other.id });
    emit({ type: "session.side-chat.created", requestId: command.requestId, sessionId: parent.id, queueItemId: input.id, session: side });
    expect(await creation).toBe(true);
    const state = useStore.getState();
    expect(state.currentSessionId).toBe(other.id);
    expect(state.backgroundSessions[parent.id]?.activeRunId).toBe("parent-run");
    expect(state.backgroundSessions[parent.id]?.messages[0]?.content).toBe("main input");
    expect(state.sideChats[side.id]).toEqual(side);
    expect(state.runOptionsBySession[side.id]).toEqual(state.runOptionsBySession[parent.id]);
    expect(state.sideChatTransfers).toEqual({});
    state.runAgent("side input", undefined, undefined, undefined, false, side.id);
    const run = commands.find((item) => item.type === "agent.run");
    expect(run && "sessionId" in run && run.sessionId).toBe(side.id);
    expect(useStore.getState().backgroundSessions[parent.id]?.activeRunId).toBe("parent-run");
    expect(useStore.getState().currentSessionId).toBe(other.id);
  } finally { useStore.setState(previous, true); }
});

test("runtime rejection clears only the transfer ticket and allows the queue to restore ownership", async () => {
  const previous = useStore.getState();
  try {
    seed(); const creation = openQueuedSideConversation(input);
    const command = commands.find((item) => item.type === "session.side-chat.create")!;
    emit({ type: "error", requestId: command.requestId, message: "fork failed" });
    await expect(creation).rejects.toThrow("fork failed");
    expect(useStore.getState().sideChatTransfers).toEqual({});
    expect(useStore.getState().sideChats).toEqual({});
    expect(useStore.getState().activeRunId).toBe("parent-run");
  } finally { useStore.setState(previous, true); }
});

test("reconnection retries the original transfer identity instead of submitting to the parent", async () => {
  const previous = useStore.getState();
  try {
    seed(); const creation = openQueuedSideConversation(input);
    const first = commands.find((item) => item.type === "session.side-chat.create")!;
    retrySideConversationTransfers();
    expect(commands.filter((item) => item.type === "session.side-chat.create")).toEqual([first, first]);
    expect(commands.some((item) => item.type === "agent.run")).toBe(false);
    emit({ type: "session.side-chat.created", requestId: first.requestId, sessionId: parent.id, queueItemId: input.id, session: side });
    expect(await creation).toBe(true);
  } finally { useStore.setState(previous, true); }
});

test("closing waits for runtime acknowledgement and scoped stop never targets the main run", async () => {
  const previous = useStore.getState();
  try {
    seed(); useStore.setState({ sideChats: { [side.id]: side }, backgroundSessions: { [side.id]: { ...emptySessionState(), running: true, activeRunId: "side-run" } } });
    useStore.getState().stopAgent(side.id);
    expect(commands.some((item) => item.type === "agent.stop" && item.runId === "side-run")).toBe(true);
    expect(commands.some((item) => item.type === "agent.stop" && item.runId === "parent-run")).toBe(false);
    const closing = closeSideConversation(side);
    const command = commands.find((item) => item.type === "session.delete")!;
    expect(useStore.getState().sideChats[side.id]).toBeDefined();
    emit({ type: "pong", requestId: command.requestId }); expect(await closing).toBe(true);
    expect(useStore.getState().sideChats[side.id]).toBeUndefined();
    expect(useStore.getState().backgroundSessions[side.id]).toBeUndefined();
    expect(useStore.getState().activeRunId).toBe("parent-run");
    expect(useStore.getState().currentSessionId).toBe(parent.id);
  } finally { useStore.setState(previous, true); }
});

test("queue preference survives reload and does not modify model, thinking or permissions", () => {
  const previous = useStore.getState();
  try {
    seed(); const options = useStore.getState().runOptionsBySession;
    useStore.getState().setFollowUpQueueMode("steer");
    expect(loadFollowUpQueueMode()).toBe("steer");
    expect(useStore.getState().runOptionsBySession).toBe(options);
    storage.set("qone-follow-up-queue-mode", "interrupt"); expect(loadFollowUpQueueMode()).toBe("steer");
    storage.set("qone-follow-up-queue-mode", "invalid"); expect(loadFollowUpQueueMode()).toBe("queue");
  } finally { useStore.setState(previous, true); }
});
