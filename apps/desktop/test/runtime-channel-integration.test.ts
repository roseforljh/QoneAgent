import { afterAll, expect, mock, test } from "bun:test";
import type { AgentEvent, RuntimeCommand, RuntimeEvent } from "@qone/protocol";

const commands: RuntimeCommand[] = [];
let channel: { onmessage: (data: unknown) => void } | undefined;
let legacy: ((event: { payload: unknown }) => void) | undefined;
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", { configurable: true, value: { __TAURI_INTERNALS__: { transformCallback: () => {} }, localStorage: { getItem: () => null, setItem: () => {} } } });
mock.module("@tauri-apps/api/core", () => ({
  Channel: class { onmessage = (_data: unknown) => {}; },
  invoke: async (name: string, args?: { channel?: typeof channel; cmd?: string }) => {
    if (name === "runtime_subscribe") channel = args?.channel;
    if (name === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
  },
}));
mock.module("@tauri-apps/api/event", () => ({ listen: async (_name: string, listener: typeof legacy) => { legacy = listener; return () => {}; } }));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));
const { initBridge, useStore } = await import("../src/store");
initBridge(); await Promise.resolve(); await Promise.resolve();
afterAll(() => { if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow); else Reflect.deleteProperty(globalThis, "window"); });
const emit = (event: RuntimeEvent) => channel!.onmessage([event]);
const execution = (sequence: number, type: string, runId: string, sessionId: string, payload: unknown, scope: AgentEvent["scope"] = "conversation"): RuntimeEvent => ({ type: "agent.event", event: { sequence, type, runId, sessionId, payload, scope, eventId: `event-${sequence}`, timestamp: sequence } });

test("Channel registration accepts Rust nested batches and ignores malformed items without stopping delivery", () => {
  expect(channel).toBeDefined(); expect(legacy).toBeDefined();
  const previous = useStore.getState();
  try {
    channel!.onmessage([null, [JSON.stringify([{ type: "session.queue", sessionId: "channel-session", items: [] }])], "invalid"]);
    expect(useStore.getState().backgroundSessions["channel-session"]!.queueLoadedSessionId).toBe("channel-session");
    legacy!({ payload: JSON.stringify({ type: "session.queue", sessionId: "legacy-session", items: [] }) });
    expect(useStore.getState().backgroundSessions["legacy-session"]!.queueLoadedSessionId).toBe("legacy-session");
  } finally { useStore.setState(previous, true); }
});

test("1000 child tool events create no ghost sessions, tools, running markers or result serialization", () => {
  const previous = useStore.getState();
  const result = { output: Array.from({ length: 1000 }, (_, index) => `result-${index}`) };
  const stringify = JSON.stringify;
  let resultSerializations = 0;
  JSON.stringify = ((value: unknown, ...args: unknown[]) => { if (value === result) resultSerializations++; return Reflect.apply(stringify, JSON, [value, ...args]); }) as typeof JSON.stringify;
  try {
    useStore.setState({ currentSessionId: "parent", backgroundSessions: {}, toolCalls: [], runningSessionIds: [] });
    const before = useStore.getState();
    for (let index = 0; index < 500; index++) {
      const sessionId = `parent::subagent::child-${index}`, runId = `child-${index}`;
      emit(execution(index * 2, "tool.started", runId, sessionId, { toolCallId: "tool", toolName: "read", args: {} }, "subagent"));
      emit(execution(index * 2 + 1, "tool.completed", runId, sessionId, { toolCallId: "tool", result }, "subagent"));
    }
    expect(useStore.getState()).toBe(before);
    expect(useStore.getState().backgroundSessions).toEqual({}); expect(useStore.getState().toolCalls).toEqual([]);
    expect(useStore.getState().runningSessionIds).toEqual([]); expect(resultSerializations).toBe(0);
    emit(execution(1001, "tool.started", "main-run", "parent", { toolCallId: "main-tool", toolName: "read", args: {} }));
    emit(execution(1002, "tool.completed", "main-run", "parent", { toolCallId: "main-tool", result }));
    expect(useStore.getState().toolCalls[0]!.result).toBe(result);
    expect(useStore.getState().toolCalls[0]!.status).toBe("success"); expect(resultSerializations).toBe(0);
  } finally { JSON.stringify = stringify; useStore.setState(previous, true); }
});

test("session selection uses one correlated snapshot command when supported and restores cached content immediately", async () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ connected: true, currentSessionId: "first", currentWorkspaceId: undefined, runtimeCapabilities: ["session.snapshot"],
      sessions: ["first", "second"].map((id) => ({ id, title: id, createdAt: 1, updatedAt: 1 })),
      backgroundSessions: { second: { ...await import("../src/lib/session-execution-state").then((module) => module.emptySessionState()), streaming: "cached" } } });
    const begin = commands.length;
    useStore.getState().selectSession("second"); await Promise.resolve();
    const selected = commands.slice(begin);
    expect(selected).toHaveLength(1); expect(selected[0]!.type).toBe("session.snapshot");
    expect(useStore.getState().streaming).toBe("cached");
    const requestId = selected[0]!.requestId;
    emit({ type: "session.messages", sessionId: "second", requestId, messages: [{ id: "saved", sessionId: "second", role: "user", content: "restored", createdAt: 1 }] });
    expect(useStore.getState().messages.map((message) => message.content)).toEqual(["restored"]);
    expect(useStore.getState().messagesLoadingSessionId).toBeUndefined();
  } finally { useStore.setState(previous, true); }
});

test("an unmounted background queue releases on a local idle transition without a shared sidebar change", async () => {
  const previous = useStore.getState();
  const { emptySessionState, sessionStore } = await import("../src/lib/session-execution-state");
  const { createQoneMessageQueue } = await import("../src/lib/qone-message-queue");
  const { bindSessionQueue } = await import("../src/lib/session-queue-lifecycle");
  let resolve!: () => void;
  const delivered = new Promise<void>((done) => { resolve = done; });
  let sends = 0;
  try {
    useStore.setState({ connected: true, currentSessionId: "foreground", sideChats: {},
      sessions: [{ id: "queued-background", title: "queued", createdAt: 1, updatedAt: 1 }],
      backgroundSessions: { "queued-background": { ...emptySessionState(), running: true } } });
    const owner = sessionStore(useStore, "queued-background");
    const queue = createQoneMessageQueue({ sessionId: "queued-background", isRunning: () => owner.getState().running,
      send: () => { sends++; resolve(); }, steer: async () => false, sync: () => {} });
    bindSessionQueue("queued-background", queue);
    queue.adapter.enqueue({ role: "user", parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(), metadata: { custom: {} }, content: [{ type: "text", text: "queued next" }], attachments: [] });
    await Promise.resolve(); expect(sends).toBe(0);
    const runningIds = useStore.getState().runningSessionIds;
    owner.setState({ running: false });
    expect(useStore.getState().runningSessionIds).toBe(runningIds);
    await delivered;
    expect(sends).toBe(1); expect(useStore.getState().currentSessionId).toBe("foreground");
  } finally { useStore.setState({ connected: false }); useStore.setState(previous, true); }
}, 3000);
