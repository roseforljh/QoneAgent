import { afterAll, expect, mock, test } from "bun:test";
import type { QueueItemInfo, RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";

const commands: RuntimeCommand[] = [];
let listener: ((event: { payload: string }) => void) | undefined;
const originalBridge = { ...await import("../src/lib/desktop-bridge") };
mock.module("../src/lib/desktop-bridge", () => ({
  ...originalBridge,
  invoke: async (name: string, args?: { cmd?: string }) => {
    if (name === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
  },
  listen: async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; },
}));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  electronBridge: { invoke: async () => undefined, listen: async () => () => {}, convertFileSrc: (p: string) => p },
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
} });
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const { useStore, initBridge, bridgeDependencies } = await import("../src/store");
const { emptySessionState } = await import("../src/lib/session-execution-state");
const { bindSessionQueue, hydrateSessionQueue } = await import("../src/lib/session-queue-lifecycle");
initBridge();
await Promise.resolve();
const emit = (event: RuntimeEvent) => listener?.({ payload: JSON.stringify(event) });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
const session = { id: "queue-initialization", title: "New", workspaceId: "workspace", createdAt: 1, updatedAt: 1 };
const input = (text: string) => ({
  role: "user" as const, parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(),
  metadata: { custom: {} }, content: [{ type: "text" as const, text }], attachments: [],
});
function createSession() {
  const { pendingAgentRuns, stopRequestedSessionIds, forceStopRequestedSessionIds, stopRequests } = bridgeDependencies();
  pendingAgentRuns.clear(); stopRequestedSessionIds.clear(); forceStopRequestedSessionIds.clear(); stopRequests.clear();
  storage.clear();
  commands.length = 0;
  useStore.setState({ ...emptySessionState(), connected: true, currentSessionId: undefined,
    sessions: [], backgroundSessions: {}, sideChats: {}, creatingSession: false, pendingMessage: undefined,
    workspaces: [{ id: "workspace", name: "project", path: "C:\\repo", createdAt: 1, updatedAt: 1 }],
  });
  emit({ type: "session.created", session });
}

test("session creation establishes an empty hydrated queue before any submission", () => {
  const previous = useStore.getState();
  try {
    createSession();
    expect(useStore.getState().queueItems).toEqual([]);
    expect(useStore.getState().queueLoadedSessionId).toBe(session.id);
    expect(useStore.getState().editingQueueItem).toBeUndefined();
  } finally { useStore.setState(previous, true); }
});

test("a delayed enqueue echo cannot restore a sent input or overwrite the next waiting input", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    const snapshots: QueueItemInfo[][] = [];
    const queue = createQoneMessageQueue({
      sessionId: session.id,
      isRunning: () => useStore.getState().running,
      send: (message, id, attachments) => useStore.getState().runAgent(
        message.content[0]?.type === "text" ? message.content[0].text : "", undefined, attachments, id,
      ),
      steer: async () => false,
      sync: (items) => { snapshots.push(items); },
    });
    // Same hydration condition as the conversation runtime; session.created
    // must satisfy it before this queue can produce its own sync responses.
    const hydrate = () => {
      const state = useStore.getState();
      if (state.queueLoadedSessionId === session.id) hydrateSessionQueue(queue, state.queueItems);
    };
    hydrate();
    bindSessionQueue(session.id, queue);
    queue.adapter.enqueue(input("latest user input"));
    await tick();
    expect(commands.filter((command) => command.type === "agent.run")).toHaveLength(1);
    expect(useStore.getState().messages.map((message) => message.content)).toEqual(["latest user input"]);
    expect(queue.adapter.items).toHaveLength(0);
    runEvent("agent.started", "first-run");
    const enqueueEcho = snapshots.find((items) => items.some((item) => item.text === "latest user input"))!;
    expect(enqueueEcho).toHaveLength(1);
    queue.adapter.enqueue(input("next waiting input"));
    await tick();
    emit({ type: "session.queue", sessionId: session.id, items: enqueueEcho });
    hydrate();
    expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["next waiting input"]);
    expect(queue.getLocalId(enqueueEcho[0]!.id)).toBeUndefined();
    useStore.setState({ running: false });
    await tick();
    expect(commands.filter((command) => command.type === "agent.run").map((command) => command.message))
      .toEqual(["latest user input", "next waiting input"]);
    expect(queue.adapter.items).toHaveLength(0);
  } finally {
    useStore.setState({ connected: false });
    useStore.setState(previous, true);
  }
});

test("consecutive stops allow new sends and a rejected in-flight steer returns to the queue", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    const queue = createQoneMessageQueue({
      sessionId: session.id,
      isRunning: () => useStore.getState().running,
      getActiveRunId: () => useStore.getState().activeRunId,
      send: (message, id, attachments) => useStore.getState().runAgent(
        message.content[0]?.type === "text" ? message.content[0].text : "", undefined, attachments, id,
      ),
      steer: (message, queueItemId, attachments, runId) => useStore.getState().steerAgent({
        sessionId: session.id, runId, queueItemId, attachments,
        message: message.content[0]?.type === "text" ? message.content[0].text : "",
      }),
      sync: () => {},
    });
    hydrateSessionQueue(queue, []);
    bindSessionQueue(session.id, queue);
    let sequence = 0;
    const event = (type: "agent.started" | "agent.cancelled", runId: string) => emit({
      type: "agent.event", event: { eventId: crypto.randomUUID(), sessionId: session.id,
        runId, type, sequence: ++sequence, timestamp: Date.now(), payload: {} },
    });
    for (const [index, text] of ["download", "where are you stuck?"].entries()) {
      queue.adapter.enqueue(input(text));
      await tick();
      expect(commands.filter((command) => command.type === "agent.run")).toHaveLength(index + 1);
      event("agent.started", `run-${index}`);
      useStore.getState().stopAgent();
      event("agent.cancelled", `run-${index}`);
      await tick();
      expect(useStore.getState().running).toBe(false);
      expect(useStore.getState().activeRunId).toBeUndefined();
    }
    queue.adapter.enqueue(input("stop downloading and answer"));
    await tick();
    expect(commands.filter((command) => command.type === "agent.run")).toHaveLength(3);
    expect(queue.adapter.items).toHaveLength(0);
    event("agent.started", "run-2");
    queue.adapter.enqueue(input("clarification"));
    await tick();
    queue.steerNow(queue.adapter.items[0]!.id);
    await tick();
    const steer = commands.find((command) => command.type === "agent.steer")!;
    event("agent.cancelled", "run-2");
    emit({ type: "error", requestId: steer.requestId, message: "Agent is no longer running" });
    await tick();
    expect(commands.filter((command) => command.type === "agent.run").map((command) => command.message))
      .toEqual(["download", "where are you stuck?", "stop downloading and answer", "clarification"]);
    expect(queue.adapter.steerItems).toHaveLength(0);
    expect(queue.adapter.items).toHaveLength(0);
    expect(useStore.getState().lastError).toBeUndefined();
  } finally {
    useStore.setState({ connected: false });
    useStore.setState(previous, true);
  }
});

test("terminal recovery without a start event acknowledges the saved input and releases the next queue item", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    const queue = boundQueue();
    queue.adapter.enqueue(input("first")); queue.adapter.enqueue(input("second")); await tick();
    const first = commands.find(command => command.type === "agent.run")!;
    if (first.type !== "agent.run") throw new Error("missing run");
    emit({ type: "pong", requestId: first.requestId });
    emit({ type: "session.runs", sessionId: session.id, runs: [{ id: "missed-run", sessionId: session.id, status: "completed", startedAt: 1 }] });
    expect(useStore.getState().running).toBe(true);
    emit({ type: "session.messages", sessionId: session.id, messages: [{ id: first.messageId!, sessionId: session.id, runId: "missed-run", role: "user", content: "first", createdAt: 1 }] });
    expect(queue.getSnapshot().map(item => item.text)).toEqual(["second"]);
    emit({ type: "session.runs", sessionId: session.id, runs: [{ id: "missed-run", sessionId: session.id, status: "completed", startedAt: 1 }] });
    expect(useStore.getState().running).toBe(false);
    await tick();
    expect(runs()).toEqual(["first", "second"]);
    expect(queue.adapter.items).toHaveLength(0);
    expect(queue.getSnapshot().map(item => item.text)).toEqual(["second"]);
    // A history refresh for the previous run cannot settle the new pending input.
    emit({ type: "session.messages", sessionId: session.id, messages: [{ id: first.messageId!, sessionId: session.id, runId: "missed-run", role: "user", content: "first", createdAt: 1 }] });
    emit({ type: "session.runs", sessionId: session.id, runs: [{ id: "missed-run", sessionId: session.id, status: "completed", startedAt: 1 }] });
    expect(useStore.getState().running).toBe(true);
    expect(queue.getSnapshot().map(item => item.text)).toEqual(["second"]);
  } finally { useStore.setState({ connected: false }); useStore.setState(previous, true); }
});

test("late terminal events cannot erase stop intent for a new run awaiting its id", async () => {
  const previous = useStore.getState();
  try {
    createSession(); const queue = boundQueue();
    queue.adapter.enqueue(input("old")); await tick(); runEvent("agent.started", "old-run");
    runEvent("agent.cancelled", "old-run");
    queue.adapter.enqueue(input("new")); await tick();
    useStore.getState().stopAgent();
    expect(useStore.getState().stoppingRunId).toBeNull();
    runEvent("agent.cancelled", "old-run");
    expect(useStore.getState().stoppingRunId).toBeNull();
    runEvent("agent.started", "new-run");
    expect(commands.filter(command => command.type === "agent.stop")).toContainEqual(expect.objectContaining({ runId: "new-run" }));
    runEvent("agent.cancelled", "new-run");
  } finally { useStore.setState({ connected: false }); useStore.setState(previous, true); }
});

const textOf = (message: { content: readonly { type: string; text?: string }[] }) => message.content[0]?.type === "text" ? message.content[0].text ?? "" : "";
const runs = () => commands.filter((command) => command.type === "agent.run").map((command) => command.type === "agent.run" ? command.message : "");
let eventSequence = 1000;
const runEvent = (type: "agent.started" | "agent.cancelled", runId: string) => emit({
  type: "agent.event", event: { eventId: crypto.randomUUID(), sessionId: session.id, runId, type, sequence: ++eventSequence, timestamp: Date.now(), payload: {} },
});
function boundQueue(send?: (message: Parameters<Parameters<typeof createQoneMessageQueue>[0]["send"]>[0], id: string) => boolean) {
  const queue = createQoneMessageQueue({
    sessionId: session.id,
    isRunning: () => useStore.getState().running,
    getActiveRunId: () => useStore.getState().activeRunId,
    send: send ?? ((message, id, attachments) => useStore.getState().runAgent(textOf(message), undefined, attachments, id)),
    steer: async () => false,
    sync: () => {},
  });
  hydrateSessionQueue(queue, []);
  bindSessionQueue(session.id, queue);
  return queue;
}

test("an input refused before reaching the runtime stays first in line and the queue does not stall", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    let attempts = 0;
    const queue = boundQueue((message, id) => attempts++ === 0 ? false : useStore.getState().runAgent(textOf(message), undefined, undefined, id));
    queue.adapter.enqueue(input("first"));
    await tick();
    // Refused: nothing was sent, nothing was lost, and nothing loops.
    expect(runs()).toEqual([]);
    expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["first"]);
    expect(attempts).toBe(1);
    // The next idle transition retries it in place.
    useStore.setState({ running: true });
    useStore.setState({ running: false });
    await tick();
    expect(runs()).toEqual(["first"]);
    queue.adapter.enqueue(input("second"));
    await tick();
    expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["second"]);
  } finally {
    useStore.setState({ connected: false });
    useStore.setState(previous, true);
  }
});

test("stopping keeps queued inputs waiting until the user sends again, then FIFO resumes", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    const queue = boundQueue();
    queue.adapter.enqueue(input("task"));
    await tick();
    runEvent("agent.started", "run-a");
    queue.adapter.enqueue(input("queued while running"));
    await tick();
    useStore.getState().stopAgent();
    runEvent("agent.cancelled", "run-a");
    await tick();
    expect(useStore.getState().running).toBe(false);
    expect(runs()).toEqual(["task"]);
    expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["queued while running"]);
    // A new send is the go-ahead: the older input goes first, the new one waits.
    queue.adapter.enqueue(input("new input"));
    await tick();
    expect(runs()).toEqual(["task", "queued while running"]);
    expect(queue.adapter.items.map((item) => item.prompt)).toEqual(["new input"]);
  } finally {
    useStore.setState({ connected: false });
    useStore.setState(previous, true);
  }
});

test("a runtime refusal restores the input without automatically retrying or consuming the next item", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    const queue = boundQueue();
    queue.adapter.enqueue(input("refused"));
    await tick();
    const command = commands.find(command => command.type === "agent.run")!;
    queue.adapter.enqueue(input("next"));
    await tick();
    emit({ type: "error", requestId: command.requestId, message: "MCP unavailable" });
    await tick();
    expect(runs()).toEqual(["refused"]);
    expect(queue.adapter.items.map(item => item.prompt)).toEqual(["refused", "next"]);
    queue.steerNow(queue.adapter.items[0]!.id);
    await tick();
    expect(runs()).toEqual(["refused", "refused"]);
    expect(queue.adapter.items.map(item => item.prompt)).toEqual(["next"]);
  } finally { useStore.setState({ connected: false }); useStore.setState(previous, true); }
});

test("two stop clicks before the run id arrives preserve the forced-stop intent", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    boundQueue().adapter.enqueue(input("starting"));
    await tick();
    useStore.getState().stopAgent();
    expect(useStore.getState().stoppingRunId).toBeNull();
    useStore.getState().stopAgent();
    runEvent("agent.started", "late-run");
    expect(commands.filter(command => command.type === "agent.stop")).toEqual([
      expect.objectContaining({ runId: "late-run", force: true }),
    ]);
    runEvent("agent.cancelled", "late-run");
    expect(useStore.getState().stoppingRunId).toBeUndefined();
  } finally { useStore.setState({ connected: false }); useStore.setState(previous, true); }
});

test("paused queues survive recreation and explicit send-now resumes the selected input", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    const queue = boundQueue();
    useStore.setState({ running: true });
    queue.adapter.enqueue(input("kept after restart"));
    await tick();
    const snapshot = queue.getSnapshot();
    queue.pauseAfterStop();
    useStore.setState({ connected: false, running: false });
    const sent: string[] = [];
    const restored = createQoneMessageQueue({ sessionId: session.id, isRunning: () => false, steer: async () => false,
      sync: () => {}, send: message => { sent.push(textOf(message)); } });
    restored.restore(snapshot);
    await tick();
    expect(sent).toEqual([]);
    restored.steerNow(restored.adapter.items[0]!.id);
    await tick();
    expect(sent).toEqual(["kept after restart"]);
  } finally { storage.clear(); useStore.setState({ connected: false }); useStore.setState(previous, true); }
});

test("pressing stop again while the run is still active forces it with the same button", async () => {
  const previous = useStore.getState();
  try {
    createSession();
    boundQueue().adapter.enqueue(input("hangs"));
    await tick();
    runEvent("agent.started", "run-hung");
    useStore.getState().stopAgent();
    expect(useStore.getState().stoppingRunId).toBe("run-hung");
    useStore.getState().stopAgent();
    const stops = commands.filter((command) => command.type === "agent.stop");
    expect(stops.map((command) => command.type === "agent.stop" && [command.runId, Boolean(command.force)])).toEqual([["run-hung", false], ["run-hung", true]]);
    runEvent("agent.cancelled", "run-hung");
    await tick();
    expect(useStore.getState().running).toBe(false);
  } finally {
    useStore.setState({ connected: false });
    useStore.setState(previous, true);
  }
});
