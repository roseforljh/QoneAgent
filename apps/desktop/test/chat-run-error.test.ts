import { afterAll, expect, mock, test } from "bun:test";
import type { AgentEvent, RuntimeCommand, RuntimeEvent } from "@qone/protocol";

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

const storage = new Map<string, string>();
const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
Object.defineProperty(globalThis, "window", {
  configurable: true,
  value: {
    __TAURI_INTERNALS__: {},
    localStorage: {
      getItem: (key: string) => storage.get(key) ?? null,
      setItem: (key: string, value: string) => storage.set(key, value),
    },
  },
});
afterAll(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

const { initBridge, useStore } = await import("../src/store");
initBridge();
await Promise.resolve();

const emit = (message: RuntimeEvent) => onRuntimeEvent?.({ payload: JSON.stringify(message) });
const event = (type: string, payload: unknown): AgentEvent => ({
  eventId: crypto.randomUUID(),
  sessionId: "session-1",
  runId: "run-1",
  sequence: 1,
  type,
  timestamp: Date.now(),
  payload,
});

test("failed reply stays with its user message and retry replaces that turn once", () => {
  useStore.setState({
    currentSessionId: "session-1",
    sessions: [{ id: "session-1", title: "Test", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
    workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
    messages: [],
    running: false,
    lastError: undefined,
    chatRunError: undefined,
  });

  useStore.getState().runAgent("hello");
  const firstUserId = useStore.getState().messages[0]?.id;
  expect(firstUserId).toBeString();
  emit({ type: "agent.event", event: event("agent.started", { runId: "run-1" }) });
  emit({ type: "agent.event", event: event("agent.failed", { message: "model unavailable" }) });

  expect(useStore.getState().chatRunError).toEqual({
    sessionId: "session-1",
    userMessageId: firstUserId,
    detail: "model unavailable",
  });
  expect(useStore.getState().lastError).toBeUndefined();
  expect(useStore.getState().messages).toHaveLength(1);

  useStore.getState().runAgent("hello", firstUserId);
  expect(useStore.getState().messages).toHaveLength(1);
  const retryUserId = useStore.getState().messages[0]?.id;
  expect(retryUserId).not.toBe(firstUserId);
  expect(useStore.getState().chatRunError).toBeUndefined();

  emit({ type: "session.messages", sessionId: "session-1", messages: [
    { id: firstUserId!, sessionId: "session-1", role: "user", content: "hello", createdAt: 0 },
  ] });
  expect(useStore.getState().messages.map((message) => message.id)).toEqual([retryUserId]);
  emit({ type: "agent.event", event: event("agent.failed", { message: "old failure" }) });
  expect(useStore.getState().chatRunError).toBeUndefined();
  expect(useStore.getState().running).toBe(true);

  const retryCommand = commands.filter((command) => command.type === "agent.run").at(-1);
  expect(retryCommand?.type).toBe("agent.run");
  if (retryCommand?.type !== "agent.run") return;
  emit({ type: "error", requestId: retryCommand.requestId, message: "request rejected" });
  expect(useStore.getState().chatRunError?.detail).toBe("request rejected");
  expect(useStore.getState().messages).toHaveLength(1);
  expect(useStore.getState().running).toBe(false);
});
