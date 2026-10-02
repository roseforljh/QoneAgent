import { afterAll, expect, mock, test } from "bun:test";
import type { QueueItemInfo, RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";

const commands: RuntimeCommand[] = [];
let listener: ((event: { payload: string }) => void) | undefined;
const originalCore = { ...await import("@tauri-apps/api/core") };
mock.module("@tauri-apps/api/core", () => ({ ...originalCore, invoke: async (name: string, args?: { cmd?: string }) => {
  if (name === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
} }));
mock.module("@tauri-apps/api/event", () => ({ listen: async (_name: string, callback: typeof listener) => { listener = callback; return () => {}; } }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const storage = new Map<string, string>();
Object.defineProperty(globalThis, "window", { configurable: true, value: {
  __TAURI_INTERNALS__: {},
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
} });
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const { useStore, initBridge } = await import("../src/store");
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
