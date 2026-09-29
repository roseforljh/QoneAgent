import { afterAll, expect, mock, test } from "bun:test";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

const commands: RuntimeCommand[] = [];
let onRuntimeEvent: ((event: { payload: string }) => void) | undefined;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { cmd?: string }) => {
    if (command === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
  },
}));
mock.module("@tauri-apps/api/event", () => ({
  listen: async (_name: string, listener: typeof onRuntimeEvent) => {
    onRuntimeEvent = listener;
    return () => {};
  },
}));
mock.module("@tauri-apps/plugin-opener", () => ({ openUrl: async () => {} }));

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: { __TAURI_INTERNALS__: {}, localStorage: { getItem: () => null, setItem: () => {} } },
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const { initBridge, useStore } = await import("../src/store");
initBridge();
await Promise.resolve();
const emit = (event: RuntimeEvent) => onRuntimeEvent?.({ payload: JSON.stringify(event) });
const emitLegacy = (event: Record<string, unknown>) => onRuntimeEvent?.({ payload: JSON.stringify(event) });

test("manual compaction stays attached to its session and reloads as a timeline marker", () => {
  const message = { id: "message-1", role: "assistant", content: "answer", createdAt: 100 };
  useStore.setState({
    connected: true,
    currentSessionId: "session-1",
    selectedModelId: "provider/model",
    messages: [message],
    messagesLoadingSessionId: undefined,
    compactions: [],
    compactionStatuses: {},
    running: false,
  });

  useStore.getState().compactSession();
  const command = commands.findLast((item) => item.type === "session.compact");
  expect(command?.type).toBe("session.compact");
  if (!command || command.type !== "session.compact") throw new Error("compaction command missing");
  expect(useStore.getState().compactionStatuses["session-1"]?.throughMessageId).toBe(message.id);

  useStore.setState({ currentSessionId: "session-2", messages: [], compactions: [] });
  const marker = { id: command.requestId, throughMessageId: message.id, createdAt: 200, status: "completed" as const, source: "manual" as const };
  emit({ type: "session.compacted", requestId: command.requestId, sessionId: "session-1", marker });
  expect(useStore.getState().compactionStatuses["session-1"]).toBeUndefined();
  expect(useStore.getState().compactions).toEqual([]);

  useStore.setState({ currentSessionId: "session-1" });
  emit({ type: "session.messages", sessionId: "session-1", messages: [{ ...message, sessionId: "session-1" }], compactions: [marker] });
  expect(useStore.getState().compactions).toEqual([marker]);
});

test("legacy compaction completion without a marker clears progress without crashing", () => {
  const message = { id: "legacy-message", role: "assistant", content: "answer", createdAt: 100 };
  const earlierMarker = { id: "earlier-compaction", throughMessageId: "older-message", createdAt: 50, status: "completed" as const, source: "manual" as const };
  useStore.setState({
    connected: true,
    currentSessionId: "legacy-session",
    selectedModelId: "provider/model",
    messages: [message],
    messagesLoadingSessionId: undefined,
    compactions: [earlierMarker],
    compactionStatuses: {},
    running: false,
  });

  useStore.getState().compactSession();
  const command = commands.findLast((item) => item.type === "session.compact");
  if (!command || command.type !== "session.compact") throw new Error("compaction command missing");
  emitLegacy({ type: "session.compacted", requestId: command.requestId, sessionId: "legacy-session" });

  expect(useStore.getState().compactionStatuses["legacy-session"]).toBeUndefined();
  expect(useStore.getState().compactions).toEqual([earlierMarker, {
    id: command.requestId,
    throughMessageId: message.id,
    createdAt: expect.any(Number),
    status: "completed",
    source: "manual",
  }]);
});

test("an interrupted compaction replaces its running marker with an error row", () => {
  useStore.setState({
    connected: true,
    currentSessionId: "session-1",
    selectedModelId: "provider/model",
    messages: [{ id: "message-1", role: "assistant", content: "answer" }],
    messagesLoadingSessionId: undefined,
    compactions: [],
    compactionStatuses: {},
    running: false,
    lastError: undefined,
  });
  useStore.getState().compactSession();
  const command = commands.findLast((item) => item.type === "session.compact");
  if (!command || command.type !== "session.compact") throw new Error("compaction command missing");
  const marker = { id: command.requestId, throughMessageId: "message-1", createdAt: 300, status: "interrupted" as const, source: "manual" as const };
  emit({ type: "session.compactionInterrupted", requestId: command.requestId, sessionId: "session-1", marker, message: "model unavailable" });

  expect(useStore.getState().compactionStatuses["session-1"]).toBeUndefined();
  expect(useStore.getState().compactions).toEqual([marker]);
  expect(useStore.getState().lastError).toBe("model unavailable");
});

test("automatic compaction events appear in the same conversation timeline", () => {
  useStore.setState({
    currentSessionId: "session-1",
    messages: [{ id: "user-1", role: "user", content: "question", runId: "run-1" }],
    compactions: [],
    autoCompactionStatuses: {},
  });
  emit({ type: "agent.event", event: {
    eventId: "start-event", sequence: 100, sessionId: "session-1", runId: "run-1", type: "context.compaction.started", timestamp: 400,
    payload: { id: "start-event", throughMessageId: "user-1", startedAt: 400, source: "automatic" },
  } });
  expect(useStore.getState().autoCompactionStatuses["session-1"]?.throughMessageId).toBe("user-1");

  emit({ type: "agent.event", event: {
    eventId: "finish-event", sequence: 101, sessionId: "session-1", runId: "run-1", type: "context.compacted", timestamp: 500,
    payload: { id: "auto-1", throughMessageId: "user-1", createdAt: 500, status: "completed", source: "automatic" },
  } });
  expect(useStore.getState().autoCompactionStatuses["session-1"]).toBeUndefined();
  expect(useStore.getState().compactions).toEqual([{ id: "auto-1", throughMessageId: "user-1", createdAt: 500, status: "completed", source: "automatic" }]);
});
