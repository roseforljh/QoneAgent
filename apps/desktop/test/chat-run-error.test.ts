import { afterAll, expect, mock, test } from "bun:test";
import type { AgentEvent, RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";

const commands: RuntimeCommand[] = [];
let onRuntimeEvent: ((event: { payload: string }) => void) | undefined;

mock.module("@tauri-apps/api/core", () => ({
  invoke: async (command: string, args?: { cmd?: string; key?: string }) => {
    if (command === "runtime_send" && args?.cmd) commands.push(JSON.parse(args.cmd));
    if (command === "secret_get" && args?.key === "mcp.env:mcp-key-restore/TEST_API_KEY") return "restored-test-key";
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

test("MCP loading survives the saved list and clears on success or failure", async () => {
  const previous = useStore.getState();
  try {
    emit({ type: "mcp.list", servers: [{ id: "preset", name: "Preset", connected: false }, { id: "other", name: "Other", connected: false }] });
    expect(useStore.getState().mcpServers.map((server) => server.id)).toEqual(["preset", "other"]);

    await useStore.getState().send({ type: "mcp.connect", requestId: "connect-ok", config: { id: "preset", name: "Preset", command: "npx" } });
    expect(useStore.getState().mcpConnectingIds).toEqual(["preset"]);
    emit({ type: "mcp.list", servers: [{ id: "preset", name: "Preset", connected: false }, { id: "other", name: "Other", connected: false }] });
    expect(useStore.getState().mcpConnectingIds).toEqual(["preset"]);
    emit({ type: "mcp.connected", serverId: "preset", toolCount: 3 });
    expect(useStore.getState().mcpConnectingIds).toEqual([]);
    expect(useStore.getState().mcpServers).toEqual([
      { id: "preset", name: "Preset", connected: true, toolCount: 3 },
      { id: "other", name: "Other", connected: false },
    ]);

    await useStore.getState().send({ type: "mcp.connect", requestId: "connect-failed", config: { id: "other", name: "Other", command: "npx" } });
    expect(useStore.getState().mcpConnectingIds).toEqual(["other"]);
    emit({ type: "error", requestId: "connect-failed", message: "connection failed" });
    expect(useStore.getState().mcpConnectingIds).toEqual([]);
  } finally {
    useStore.setState(previous, true);
  }
});

test("restores a key preset credential when the saved MCP list arrives", async () => {
  const start = commands.length;
  emit({ type: "mcp.list", servers: [{
    id: "mcp-key-restore", name: "Key test", command: "npx", connected: false,
    env: { TEST_API_KEY: "$mcp.env:mcp-key-restore/TEST_API_KEY" },
  }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(commands.slice(start)).toContainEqual(expect.objectContaining({
    type: "secret.set", key: "mcp.env:mcp-key-restore/TEST_API_KEY", value: "restored-test-key",
  }));
});

test("shows an install hint when an MCP preset cannot find Node.js/npm", async () => {
  const previous = useStore.getState();
  try {
    await useStore.getState().send({ type: "mcp.connect", requestId: "missing-npx", config: { id: "mcp-firecrawl", name: "Firecrawl", command: "npx" } });
    emit({ type: "error", requestId: "missing-npx", message: "MCP_NPX_UNAVAILABLE" });
    expect(useStore.getState().lastError).toContain("Node.js/npm");
    expect(useStore.getState().mcpConnectingIds).not.toContain("mcp-firecrawl");
  } finally {
    useStore.setState(previous, true);
  }
});

test("session creation requires an imported selected workspace at every entry", () => {
  const previous = useStore.getState();
  const start = commands.length;
  const workspace = { id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 };
  try {
    useStore.setState({ workspaces: [], currentWorkspaceId: undefined, currentSessionId: undefined, draftWorkspaceId: undefined, running: false, creatingSession: false });
    useStore.getState().newSession();
    useStore.getState().newSessionInWorkspace("missing");
    useStore.getState().createSessionForWorkspace("missing");
    expect(commands).toHaveLength(start);
    expect(useStore.getState().draftWorkspaceId).toBeUndefined();

    useStore.setState({ workspaces: [workspace], currentWorkspaceId: "deleted-workspace" });
    useStore.getState().newSession();
    expect(commands).toHaveLength(start);

    useStore.setState({ currentWorkspaceId: workspace.id, running: true });
    useStore.getState().newSession();
    expect(commands).toHaveLength(start);

    useStore.setState({ running: false });
    useStore.getState().newSession();
    expect(commands.slice(start)).toEqual([expect.objectContaining({ type: "session.create", workspaceId: workspace.id })]);

    useStore.getState().newSessionInWorkspace(workspace.id);
    expect(useStore.getState().draftWorkspaceId).toBe(workspace.id);
    useStore.getState().createSessionForWorkspace(workspace.id);
    expect(commands.filter((command) => command.type === "session.create").slice(-2)).toEqual([
      expect.objectContaining({ workspaceId: workspace.id }),
      expect.objectContaining({ workspaceId: workspace.id }),
    ]);
  } finally {
    useStore.setState(previous, true);
  }
});

test("removing a workspace refreshes sessions to exclude its orphaned chats", () => {
  const previous = useStore.getState();
  const start = commands.length;
  try {
    useStore.setState({ currentWorkspaceId: "workspace-1", currentSessionId: "session-1", workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }] });
    emit({ type: "workspace.deleted", workspaceId: "workspace-1" });
    expect(commands.slice(start)).toEqual([expect.objectContaining({ type: "session.list" })]);
    emit({ type: "session.list", sessions: [] });
    expect(useStore.getState().sessions).toEqual([]);
    expect(useStore.getState().currentSessionId).toBeUndefined();
    expect(useStore.getState().currentWorkspaceId).toBeUndefined();
  } finally {
    useStore.setState(previous, true);
  }
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

test("reloaded legacy tool rows use the persisted assistant part id", () => {
  useStore.setState({ currentSessionId: "session-legacy-tool-id", toolCalls: [], messages: [{
    id: "assistant-legacy", role: "assistant", content: "", runId: "run-legacy-tool-id", createdAt: 0,
    parts: [{ type: "tool-call", toolCallId: "pi-legacy-tool-id", toolName: "bash", args: {}, messageSequence: 1 }],
  }] });
  emit({ type: "session.toolCalls", sessionId: "session-legacy-tool-id", toolCalls: [{
    id: "legacy-random-row-id",
    runId: "run-legacy-tool-id",
    toolName: "bash",
    arguments: "{}",
    resultSummary: "ok",
    status: "success",
    startedAt: 1_000,
    completedAt: 12_000,
  }] });
  expect(useStore.getState().toolCalls[0]).toMatchObject({
    toolCallId: "pi-legacy-tool-id",
    startedAt: 1_000,
    completedAt: 12_000,
  });
});

test("streaming tool arguments update one preview without entering prose or completing the tool", () => {
  const sessionId = "live-tool-session";
  const runId = "live-tool-run";
  useStore.setState({ currentSessionId: sessionId, activeRunId: runId, running: true,
    activeMessageSequence: undefined, streaming: "", streamingParts: [], toolCalls: [], preparedToolCallIds: [] });
  const send = (type: string, sequence: number, payload: unknown, eventRunId = runId) => emit({
    type: "agent.event", event: { eventId: crypto.randomUUID(), sessionId, runId: eventRunId, sequence, type, timestamp: sequence, payload },
  });
  send("message.started", 400, { message: { role: "assistant", content: [] } });
  send("message.block.started", 401, { blockType: "tool-call", contentIndex: 0, toolName: "edit", args: {} });
  send("message.delta", 402, { blockType: "tool-call", contentIndex: 0, toolCallId: "live-edit", toolName: "edit", args: { path: "a.ts", oldText: "old", newText: "n" } });
  send("message.delta", 403, { blockType: "tool-call", contentIndex: 0, toolCallId: "live-edit", toolName: "edit", args: { path: "a.ts", oldText: "old", newText: "new" } });
  expect(useStore.getState().streaming).toBe("");
  expect(useStore.getState().streamingParts).toEqual([{
    type: "tool-call", toolCallId: "live-edit", toolName: "edit", messageSequence: 400,
    args: { path: "a.ts", oldText: "old", newText: "new" },
  }]);
  expect(useStore.getState().toolCalls).toHaveLength(0);
  expect(useStore.getState().preparedToolCallIds).toEqual([]);
  send("message.block.completed", 404, { blockType: "tool-call", contentIndex: 0, toolCallId: "live-edit", args: { path: "a.ts", oldText: "old", newText: "new final" } });
  expect(useStore.getState().preparedToolCallIds).toEqual(["live-edit"]);
  send("tool.started", 405, { toolCallId: "live-edit", toolName: "edit", args: { path: "a.ts", oldText: "old", newText: "new final" } });
  send("tool.updated", 406, { toolCallId: "live-edit", update: "applying" });
  expect(useStore.getState().toolCalls[0]).toMatchObject({ result: "applying", status: "running" });
  send("tool.updated", 407, { toolCallId: "live-edit", update: "wrong run" }, "another-run");
  expect(useStore.getState().toolCalls[0]?.result).toBe("applying");
  send("tool.completed", 408, { toolCallId: "live-edit", result: "done" });
  send("tool.updated", 409, { toolCallId: "live-edit", update: "late update" });
  expect(useStore.getState().toolCalls[0]).toMatchObject({ result: "done", status: "success" });
  expect(useStore.getState().streamingParts).toHaveLength(1);
});
