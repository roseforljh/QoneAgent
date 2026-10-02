import { afterAll, expect, mock, test } from "bun:test";
import type { RuntimeCommand, RuntimeEvent, SessionInfo } from "@qone/protocol";

const commands: RuntimeCommand[] = [];
let listener: ((event: { payload: string }) => void) | undefined;
mock.module("@tauri-apps/api/core", () => ({ invoke: async (name: string, args?: { cmd?: string }) => {
  if (name === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
} }));
mock.module("@tauri-apps/api/event", () => ({ listen: async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; } }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: {} } });
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });

const { useStore, initBridge } = await import("../src/store");
const { openSideConversation, openQueuedSideConversation, closeSideConversation, retrySideConversationTransfers } = await import("../src/lib/side-conversation");
const { emptySessionState, switchSessionState } = await import("../src/lib/session-execution-state");
const { composerDrafts } = await import("../src/lib/composer-drafts");
const { createConversationStore } = await import("../src/lib/conversation-store");
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

test("selected text seeds the matching side-chat draft before tab publication without submitting", async () => {
  const previous = useStore.getState();
  const quote = { text: "selected reference", messageId: "old" };
  let publishedQuote: unknown;
  const unsubscribe = useStore.subscribe((state) => { if (state.sideChats[side.id]) publishedQuote = composerDrafts.get(side.id)?.quote; });
  try {
    seed();
    composerDrafts.set(parent.id, { text: "keep parent draft", quote: undefined, attachments: [] });
    const creation = openSideConversation(parent.id, { text: "", quote, attachments: [] });
    const command = commands.find((item) => item.type === "session.side-chat.create")!;
    retrySideConversationTransfers();
    expect(commands.filter((item) => item.type === "session.side-chat.create").every((item) => item.requestId === command.requestId)).toBe(true);
    useStore.setState({ ...switchSessionState(useStore.getState(), other.id), currentSessionId: other.id });
    emit({ type: "session.side-chat.created", requestId: command.requestId, sessionId: parent.id, session: side });
    await creation;
    expect(publishedQuote).toEqual(quote);
    expect(composerDrafts.get(side.id)).toEqual({ text: "", quote, attachments: [] });
    expect(composerDrafts.get(parent.id)?.text).toBe("keep parent draft");
    expect(useStore.getState().currentSessionId).toBe(other.id);
    expect(commands.some((item) => item.type === "agent.run")).toBe(false);
  } finally {
    unsubscribe(); composerDrafts.set(side.id, { text: "", attachments: [], quote: undefined });
    composerDrafts.set(parent.id, { text: "", attachments: [], quote: undefined }); useStore.setState(previous, true);
  }
});

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

test("opening a side chat routes its messages and queue without changing the parent session", async () => {
  const previous = useStore.getState();
  try {
    seed();
    const remaining = { ...input, id: "remaining", text: "parent waiting" };
    useStore.setState({ queueItems: [input, remaining], queueLoadedSessionId: parent.id });
    const creation = openQueuedSideConversation(input);
    const command = commands.find((item) => item.type === "session.side-chat.create")!;
    emit({ type: "session.side-chat.created", requestId: command.requestId, sessionId: parent.id, queueItemId: input.id, session: side });
    expect(await creation).toBe(true);
    emit({ type: "session.queue", sessionId: parent.id, items: [remaining] });
    emit({ type: "session.messages", sessionId: side.id, messages: [{ id: "side-history", sessionId: side.id, role: "user", content: "reference history", createdAt: 1 }] });
    const childInput = { ...input, id: "child-input", sessionId: side.id };
    emit({ type: "session.queue", sessionId: side.id, items: [childInput] });
    const state = useStore.getState();
    expect(state.currentSessionId).toBe(parent.id);
    expect(state.activeRunId).toBe("parent-run");
    expect(state.messages[0]?.content).toBe("main input");
    expect(state.queueItems).toEqual([remaining]);
    expect(state.queueLoadedSessionId).toBe(parent.id);
    expect(state.backgroundSessions[side.id]?.messages[0]?.content).toBe("reference history");
    expect(state.backgroundSessions[side.id]?.queueItems).toEqual([childInput]);
    expect(state.backgroundSessions[side.id]?.queueLoadedSessionId).toBe(side.id);
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

test("standalone creation preserves the active main run, queued input and draft while inheriting configuration", async () => {
  const previous = useStore.getState();
  try {
    seed();
    const editing = { ...input, status: "scheduled" as const };
    useStore.setState({ queueItems: [input], editingQueueItem: editing, queueLoadedSessionId: parent.id });
    const creation = openSideConversation(parent.id);
    const command = commands.find((item) => item.type === "session.side-chat.create")!;
    expect(command).toMatchObject({ sessionId: parent.id, title: "Side chat" });
    expect("queueItemId" in command).toBe(false);
    expect(useStore.getState().sideChatTransfers).toEqual({});
    emit({ type: "session.side-chat.created", requestId: command.requestId, sessionId: parent.id, session: side });
    expect(await creation).toBe(true);
    const state = useStore.getState();
    expect(state.currentSessionId).toBe(parent.id);
    expect(state.activeRunId).toBe("parent-run");
    expect(state.queueItems).toEqual([input]);
    expect(state.editingQueueItem).toEqual(editing);
    expect(state.runOptionsBySession[side.id]).toEqual(state.runOptionsBySession[parent.id]);
    expect(commands.some((item) => item.type === "agent.run" || item.type === "queue.sync")).toBe(false);

    const owner = createConversationStore(useStore, side.id);
    owner.getState().setSelectedModel("another/model");
    owner.getState().setRunPermissionMode("ask");
    owner.getState().setRunThinking("test/model", "low");
    expect(owner.getState().selectedModelId).toBe("another/model");
    expect(useStore.getState().selectedModelId).toBe("test/model");
    expect(useStore.getState().runOptionsBySession[parent.id]).toEqual({ modelId: "test/model", permissionMode: "full", thinkingByModel: { "test/model": "high" } });
    expect(useStore.getState().runOptionsBySession[side.id]).toEqual({ modelId: "another/model", permissionMode: "ask", thinkingByModel: { "test/model": "low" } });
  } finally { useStore.setState(previous, true); }
});

test("standalone retry retains its request and source session across navigation without transferring any input", async () => {
  const previous = useStore.getState();
  try {
    seed();
    const creation = openSideConversation(parent.id);
    const command = commands.find((item) => item.type === "session.side-chat.create")!;
    useStore.setState({ ...switchSessionState(useStore.getState(), other.id), currentSessionId: other.id });
    retrySideConversationTransfers();
    expect(commands.filter((item) => item.type === "session.side-chat.create")).toEqual([command, command]);
    emit({ type: "session.side-chat.created", requestId: command.requestId, sessionId: parent.id, session: side });
    expect(await creation).toBe(true);
    expect(useStore.getState().currentSessionId).toBe(other.id);
    expect(useStore.getState().backgroundSessions[parent.id]?.activeRunId).toBe("parent-run");
    expect(useStore.getState().sideChats[side.id]).toEqual(side);
    expect(useStore.getState().sideChatTransfers).toEqual({});
  } finally { useStore.setState(previous, true); }
});

test("concurrent standalone requests keep independent configuration when acknowledgements arrive out of order", async () => {
  const previous = useStore.getState();
  try {
    seed();
    const firstCreation = openSideConversation(parent.id);
    const first = commands.find((command) => command.type === "session.side-chat.create")!;
    const secondOptions = { modelId: "another/model", permissionMode: "ask" as const, thinkingByModel: { "another/model": "low" as const } };
    useStore.setState({ runOptionsBySession: { [parent.id]: secondOptions } });
    const secondCreation = openSideConversation(parent.id);
    const second = commands.filter((command) => command.type === "session.side-chat.create").at(-1)!;
    expect(second.requestId).not.toBe(first.requestId);
    retrySideConversationTransfers();
    expect(commands.filter((command) => command.type === "session.side-chat.create")).toEqual([first, second, first, second]);

    const secondSide = { ...side, id: "second-side" };
    emit({ type: "session.side-chat.created", requestId: second.requestId, sessionId: parent.id, session: secondSide });
    expect(await secondCreation).toBe(true);
    expect(useStore.getState().sideChats[side.id]).toBeUndefined();
    emit({ type: "session.side-chat.created", requestId: first.requestId, sessionId: parent.id, session: side });
    expect(await firstCreation).toBe(true);
    expect(useStore.getState().sideChats).toEqual({ [secondSide.id]: secondSide, [side.id]: side });
    expect(useStore.getState().runOptionsBySession[side.id]).toEqual({ modelId: "test/model", permissionMode: "full", thinkingByModel: { "test/model": "high" } });
    expect(useStore.getState().runOptionsBySession[secondSide.id]).toEqual(secondOptions);
    expect(useStore.getState().activeRunId).toBe("parent-run");
    expect(useStore.getState().currentSessionId).toBe(parent.id);
    expect(commands.some((command) => command.type === "agent.run" || command.type === "queue.sync")).toBe(false);

    const thirdCreation = openSideConversation(parent.id);
    const third = commands.filter((command) => command.type === "session.side-chat.create").at(-1)!;
    emit({ type: "error", requestId: third.requestId, message: "third creation failed" });
    await expect(thirdCreation).rejects.toThrow("third creation failed");
    expect(Object.keys(useStore.getState().sideChats)).toHaveLength(2);

    const closing = closeSideConversation(side);
    const deletion = commands.find((command) => command.type === "session.delete")!;
    emit({ type: "pong", requestId: deletion.requestId });
    expect(await closing).toBe(true);
    expect(useStore.getState().sideChats).toEqual({ [secondSide.id]: secondSide });
    expect(useStore.getState().backgroundSessions[secondSide.id]).toBeDefined();
    expect(useStore.getState().runOptionsBySession[secondSide.id]).toEqual(secondOptions);
    expect(useStore.getState().activeRunId).toBe("parent-run");
  } finally { useStore.setState(previous, true); }
});
