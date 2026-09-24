import { afterAll, expect, mock, test } from "bun:test";
import type { AgentEvent, RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";

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

test("live assistant parts and reloaded parts keep the same Pi order", async () => {
  const sessionId = "session-order";
  const runId = "run-order";
  const user = { id: "user-order", sessionId, runId, role: "user", content: "检查", createdAt: 1 };
  useStore.setState({
    currentSessionId: sessionId,
    messages: [user],
    running: true,
    activeRunId: runId,
    streaming: "",
    streamingParts: [],
    toolCalls: [],
    chatRunError: undefined,
  });
  const emitPart = (type: string, sequence: number, payload: unknown) => emit({
    type: "agent.event",
    event: { eventId: crypto.randomUUID(), sessionId, runId, sequence, type, timestamp: sequence, payload },
  });
  const completed = (sequence: number, content: unknown[]) => emitPart("message.completed", sequence, {
    message: { role: "assistant", content },
  });
  const visible = () => {
    const state = useStore.getState();
    return assistantMessageContent({ content: state.streaming, parts: state.streamingParts }, [], true);
  };

  emitPart("message.delta", 10, { delta: "旁白一" });
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(visible()).toMatchObject([{ type: "text", text: "旁白一" }]);
  completed(11, [
    { type: "text", text: "旁白一" },
    { type: "toolCall", id: "tool-a", name: "read", arguments: {} },
    { type: "toolCall", id: "tool-b", name: "grep", arguments: {} },
  ]);
  emitPart("tool.started", 12, { toolCallId: "tool-a", toolName: "read", args: {} });
  emitPart("tool.completed", 13, { toolCallId: "tool-a", result: "ok" });
  expect(visible().map((part) => part.type === "text" ? part.text : part.type === "tool-call" ? part.toolCallId : part.type)).toEqual([
    "旁白一", "tool-a", "tool-b",
  ]);

  emitPart("message.delta", 20, { delta: "阶段结论" });
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(visible().at(-1)).toMatchObject({ type: "text", text: "阶段结论" });
  completed(21, [
    { type: "text", text: "阶段结论" },
    { type: "toolCall", id: "tool-c", name: "ls", arguments: {} },
  ]);
  emitPart("tool.started", 22, { toolCallId: "tool-c", toolName: "ls", args: {} });
  emitPart("tool.completed", 23, { toolCallId: "tool-c", result: "done" });
  emitPart("message.delta", 30, { delta: "最终总结" });
  await new Promise((resolve) => setTimeout(resolve, 45));
  expect(visible().at(-1)).toMatchObject({ type: "text", text: "最终总结" });
  completed(31, [{ type: "text", text: "最终总结" }]);
  const live = visible();
  expect(live.map((part) => part.type === "text" ? part.text : part.type === "tool-call" ? part.toolCallId : part.type)).toEqual([
    "旁白一", "tool-a", "tool-b", "阶段结论", "tool-c", "最终总结",
  ]);

  const saved = { id: "assistant-order", sessionId, runId, role: "assistant", content: "最终总结", parts: useStore.getState().streamingParts, createdAt: 2 };
  emitPart("agent.completed", 32, { message: saved });
  const immediate = assistantMessageContent(useStore.getState().messages.at(-1)!, [], false);
  expect(immediate).toEqual(live);
  emit({ type: "session.messages", sessionId, messages: [user, JSON.parse(JSON.stringify(saved))] });
  const reopened = assistantMessageContent(useStore.getState().messages.at(-1)!, [], false);
  expect(reopened).toEqual(live);
});

test("one Pi message streams text and tool blocks in order before message completion", async () => {
  const sessionId = "session-block-order";
  const runId = "run-block-order";
  const user = { id: "user-block-order", sessionId, runId, role: "user", content: "检查", createdAt: 1 };
  useStore.setState({
    currentSessionId: sessionId,
    messages: [user],
    running: true,
    activeRunId: runId,
    activeMessageSequence: undefined,
    streaming: "",
    streamingParts: [],
    toolCalls: [],
  });
  const emitPart = (type: string, sequence: number, payload: unknown) => emit({
    type: "agent.event",
    event: { eventId: crypto.randomUUID(), sessionId, runId, sequence, type, timestamp: sequence, payload },
  });
  const visible = () => {
    const state = useStore.getState();
    return assistantMessageContent({ content: state.streaming, parts: state.streamingParts }, [], true);
  };
  const labels = () => visible().map((part) => part.type === "text" ? part.text : part.type === "tool-call" ? part.toolCallId : part.type);

  emitPart("message.started", 100, { message: { role: "assistant", content: [] } });
  emitPart("message.block.started", 101, { blockType: "text", contentIndex: 0 });
  emitPart("message.delta", 102, { delta: "旁白" });
  emitPart("message.block.started", 103, { blockType: "tool-call", contentIndex: 1, toolCallId: "a", toolName: "read", args: {} });
  expect(labels()).toEqual(["旁白", "a"]);
  emitPart("message.block.completed", 104, { blockType: "tool-call", contentIndex: 1, toolCallId: "a", toolName: "read", args: { path: "a" } });
  emitPart("message.block.started", 105, { blockType: "tool-call", contentIndex: 2, toolName: "grep", args: {} });
  expect(labels()).toEqual(["旁白", "a", "pi-100-2"]);
  emitPart("message.block.completed", 106, { blockType: "tool-call", contentIndex: 2, toolCallId: "b", toolName: "grep", args: { pattern: "b" } });
  expect(labels()).toEqual(["旁白", "a", "b"]);
  emitPart("message.block.started", 107, { blockType: "text", contentIndex: 3 });
  emitPart("message.delta", 108, { delta: "阶段结论" });
  emitPart("message.block.started", 109, { blockType: "tool-call", contentIndex: 4, toolCallId: "c", toolName: "ls", args: {} });
  expect(labels()).toEqual(["旁白", "a", "b", "阶段结论", "c"]);
  emitPart("message.block.started", 110, { blockType: "tool-call", contentIndex: 5, toolCallId: "d", toolName: "read", args: {} });
  emitPart("message.block.started", 111, { blockType: "text", contentIndex: 6 });
  emitPart("message.delta", 112, { delta: "最终文本" });
  await new Promise((resolve) => setTimeout(resolve, 45));
  const beforeCompletion = labels();
  expect(beforeCompletion).toEqual(["旁白", "a", "b", "阶段结论", "c", "d", "最终文本"]);

  emitPart("message.completed", 113, { message: { role: "assistant", content: [
    { type: "text", text: "旁白" },
    { type: "toolCall", id: "a", name: "read", arguments: { path: "a" } },
    { type: "toolCall", id: "b", name: "grep", arguments: { pattern: "b" } },
    { type: "text", text: "阶段结论" },
    { type: "toolCall", id: "c", name: "ls", arguments: {} },
    { type: "toolCall", id: "d", name: "read", arguments: {} },
    { type: "text", text: "最终文本" },
  ] } });
  expect(labels()).toEqual(beforeCompletion);
  for (const [index, id] of ["a", "b", "c", "d"].entries()) {
    emitPart("tool.started", 114 + index * 2, { toolCallId: id, toolName: "read", args: {} });
    emitPart("tool.completed", 115 + index * 2, { toolCallId: id, result: "ok" });
  }
  const live = visible();
  const saved = { id: "assistant-block-order", sessionId, runId, role: "assistant", content: "最终文本", parts: useStore.getState().streamingParts, createdAt: 2 };
  emitPart("agent.completed", 122, { message: saved });
  expect(assistantMessageContent(useStore.getState().messages.at(-1)!, [], false)).toEqual(live);
  emit({ type: "session.messages", sessionId, messages: [user, JSON.parse(JSON.stringify(saved))] });
  expect(assistantMessageContent(useStore.getState().messages.at(-1)!, [], false)).toEqual(live);
});

test("tool execution start creates live parts before the tool completes", () => {
  const sessionId = "session-live-tools";
  const runId = "run-live-tools";
  useStore.setState({
    currentSessionId: sessionId,
    messages: [],
    running: true,
    activeRunId: runId,
    activeMessageSequence: undefined,
    streaming: "",
    streamingParts: [],
    toolCalls: [],
  });
  const emitPart = (type: string, sequence: number, payload: unknown) => emit({
    type: "agent.event",
    event: { eventId: crypto.randomUUID(), sessionId, runId, sequence, type, timestamp: sequence, payload },
  });
  const visibleIds = () => assistantMessageContent({
    content: useStore.getState().streaming,
    parts: useStore.getState().streamingParts,
  }, [], true).map((part) => part.type === "text" ? part.text : part.type === "tool-call" ? part.toolCallId : part.type);

  emitPart("message.started", 199, { message: { role: "assistant", content: [] } });
  emitPart("message.delta", 200, { delta: "旁白" });
  emitPart("tool.started", 201, { toolCallId: "live-a", toolName: "grep", args: { pattern: "ruleSetReady" } });
  expect(visibleIds()).toEqual(["旁白", "live-a"]);
  expect(useStore.getState().toolCalls).toMatchObject([{ toolCallId: "live-a", status: "running" }]);

  emitPart("tool.completed", 202, { toolCallId: "live-a", result: "match" });
  expect(useStore.getState().streamingParts[1]).toMatchObject({ toolCallId: "live-a", result: "match" });
  expect(useStore.getState().toolCalls[0]?.status).toBe("success");

  emitPart("tool.started", 203, { toolCallId: "live-b", toolName: "read", args: { path: "RuleSetRepository.kt" } });
  expect(visibleIds()).toEqual(["旁白", "live-a", "live-b"]);
  expect(useStore.getState().toolCalls[1]).toMatchObject({ toolCallId: "live-b", status: "running" });

  emitPart("tool.failed", 204, { toolCallId: "live-b", result: "missing", isError: true });
  expect(useStore.getState().streamingParts[2]).toMatchObject({ toolCallId: "live-b", result: "missing", isError: true });
  expect(useStore.getState().toolCalls[1]?.status).toBe("failed");

  useStore.setState({
    activeRunId: "run-live-tools-without-message-boundary",
    activeMessageSequence: undefined,
    streaming: "",
    streamingParts: [],
    toolCalls: [],
  });
  const boundaryless = (sequence: number, id: string) => emit({
    type: "agent.event",
    event: { eventId: crypto.randomUUID(), sessionId, runId: "run-live-tools-without-message-boundary", sequence, type: "tool.started", timestamp: sequence, payload: { toolCallId: id, toolName: "read", args: {} } },
  });
  boundaryless(205, "live-c");
  boundaryless(206, "live-d");
  expect(useStore.getState().streamingParts.map((part) => part.messageSequence)).toEqual([205, 205]);
});

test("completed Pi tool arguments are prepared before execution starts", () => {
  const sessionId = "session-prepared-tool";
  const runId = "run-prepared-tool";
  useStore.setState({
    currentSessionId: sessionId,
    messages: [],
    running: true,
    activeRunId: runId,
    activeMessageSequence: undefined,
    preparedToolCallIds: [],
    streaming: "",
    streamingParts: [],
    toolCalls: [],
  });
  const emitPart = (type: string, sequence: number, payload: unknown) => emit({
    type: "agent.event",
    event: { eventId: crypto.randomUUID(), sessionId, runId, sequence, type, timestamp: sequence, payload },
  });

  emitPart("message.started", 300, { message: { role: "assistant", content: [] } });
  emitPart("message.block.started", 301, { blockType: "tool-call", contentIndex: 0, toolCallId: "prepared-read", toolName: "read", args: {} });
  expect(useStore.getState().preparedToolCallIds).toEqual([]);

  emitPart("message.block.completed", 302, { blockType: "tool-call", contentIndex: 0, toolCallId: "prepared-read", toolName: "read", args: { path: "RuleSet.kt" } });
  expect(useStore.getState().preparedToolCallIds).toEqual(["prepared-read"]);

  emitPart("tool.started", 303, { toolCallId: "prepared-read", toolName: "read", args: { path: "RuleSet.kt" } });
  expect(useStore.getState().preparedToolCallIds).toEqual([]);
  expect(useStore.getState().toolCalls.at(-1)).toMatchObject({ toolCallId: "prepared-read", status: "running" });
});

test("reloaded tool rows restore the Pi tool-call id", () => {
  useStore.setState({ currentSessionId: "session-tool-id", toolCalls: [] });
  emit({ type: "session.toolCalls", sessionId: "session-tool-id", toolCalls: [{
    id: "run-tool-id:pi-tool-id",
    runId: "run-tool-id",
    toolName: "bash",
    arguments: JSON.stringify({ command: "bun test" }),
    resultSummary: "ok",
    status: "success",
    startedAt: 1_000,
    completedAt: 2_000,
  }] });
  expect(useStore.getState().toolCalls[0]).toMatchObject({
    toolCallId: "pi-tool-id",
    runId: "run-tool-id",
    startedAt: 1_000,
    completedAt: 2_000,
  });
});
