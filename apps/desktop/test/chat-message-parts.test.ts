import { beforeEach, expect, test } from "bun:test";
import type { AgentEvent } from "@qone/protocol";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";
import { commands, emit, event, requestModelMetadata, resetHarness, setSendFailure, storage, useStore } from "./helpers/chat-store-harness";

beforeEach(() => { resetHarness(); });

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


test("reasoning streams separately, settles at block end and survives completed message reload", async () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ currentSessionId: "session-1", activeRunId: "run-1", running: true, streaming: "", streamingParts: [], messages: [], activeMessageSequence: undefined });
    const send = (type: string, payload: unknown) => emit({ type: "agent.event", event: event(type, payload) });
    send("model.request.started", {});
    expect(useStore.getState().modelRequest?.runId).toBe("run-1");
    send("message.started", { message: { role: "assistant" } });
    send("message.block.started", { blockType: "reasoning", contentIndex: 0 });
    send("message.reasoning.delta", { delta: "分析", contentIndex: 0 });
    send("message.reasoning.delta", { delta: "视频", contentIndex: 0 });
    await Bun.sleep(45);
    expect(useStore.getState().streaming).toBe("");
    expect(useStore.getState().streamingParts).toMatchObject([{ type: "reasoning", text: "分析视频" }]);
    send("message.block.completed", { blockType: "reasoning", contentIndex: 0 });
    expect(useStore.getState().streamingParts[0]).toMatchObject({ complete: true });
    send("message.block.started", { blockType: "text", contentIndex: 1 });
    send("message.delta", { delta: "结果" });
    await Bun.sleep(45);
    expect(useStore.getState().streaming).toBe("结果");
    send("message.completed", { message: { role: "assistant", content: [{ type: "thinking", thinking: "分析视频" }, { type: "text", text: "结果" }] } });
    const parts = useStore.getState().streamingParts;
    expect(parts.map(p => p.type)).toEqual(["reasoning", "text"]);
    const live = assistantMessageContent({ content: "", parts }, [], true);
    expect(assistantMessageContent({ content: "结果", parts: JSON.parse(JSON.stringify(parts)) }, [], false)).toEqual(live);
    send("agent.cancelled", { message: { id: "reason-cancelled", content: "结果", parts } });
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().messages.at(-1)?.parts).toEqual(parts);
  } finally { useStore.setState(previous, true); }
});

function setupConcurrentSessions() {
  const sessions = ["background-a", "background-b"].map((id) => ({ id, title: id, workspaceId: "concurrent-workspace", createdAt: 0, updatedAt: 0 }));
  useStore.setState({
    ...useStore.getInitialState(), connected: true, sessions,
    workspaces: [{ id: "concurrent-workspace", name: "Project", path: "C:/project", createdAt: 0, updatedAt: 0 }],
    currentWorkspaceId: "concurrent-workspace",
  });
  useStore.getState().selectSession(sessions[0]!.id);
}

function emitFor(sessionId: string, type: string, payload: unknown = {}) {
  emit({ type: "agent.event", event: { ...event(type, payload), sessionId, runId: `${sessionId}-run`, sequence: 10 } });
}

test("session history loading always settles on success and runtime errors", async () => {
  const previous = useStore.getState();
  try {
    setupConcurrentSessions();
    const firstRequest = commands.filter((command) => command.type === "session.messages").at(-1)!;
    expect(useStore.getState().messagesLoadingSessionId).toBe("background-a");
    emit({ type: "session.messages", sessionId: "background-a", messages: [] });
    expect(useStore.getState().messagesLoadingSessionId).toBeUndefined();

    useStore.getState().selectSession("background-b");
    const secondRequest = commands.filter((command) => command.type === "session.messages").at(-1)!;
    await Promise.resolve();
    expect(useStore.getState().messagesLoadingSessionId).toBe("background-b");
    emit({ type: "error", requestId: secondRequest.requestId, message: "history unavailable" });
    expect(useStore.getState().messagesLoadingSessionId).toBeUndefined();
    expect(useStore.getState().lastError).toBe("history unavailable");
    expect(firstRequest.requestId).not.toBe(secondRequest.requestId);

    useStore.getState().selectSession("background-a");
    expect(useStore.getState().messagesLoadingSessionId).toBeUndefined();
  } finally { useStore.setState(previous, true); }
});

function startConcurrentRun(sessionId: string) {
  useStore.getState().selectSession(sessionId);
  useStore.getState().runAgent(`work on ${sessionId}`);
  emitFor(sessionId, "agent.started");
  emitFor(sessionId, "message.started", { message: { role: "assistant" } });
}

test("interleaved background text, reasoning, tools and approvals survive switching and creation", async () => {
  const previous = useStore.getState();
  const start = commands.length;
  try {
    setupConcurrentSessions();
    startConcurrentRun("background-a");
    emitFor("background-a", "message.delta", { delta: "A-before" });
    startConcurrentRun("background-b");
    emitFor("background-a", "message.delta", { delta: "-after" });
    emitFor("background-b", "message.delta", { delta: "B-only" });
    emitFor("background-a", "message.reasoning.delta", { delta: "A-reasoning", contentIndex: 1 });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(useStore.getState().streaming).toBe("B-only");
    expect(useStore.getState().backgroundSessions["background-a"]?.streaming).toBe("A-before-after");
    expect(useStore.getState().runningSessionIds).toEqual(expect.arrayContaining(["background-a", "background-b"]));
    emitFor("background-a", "tool.started", { toolCallId: "a-tool", toolName: "read", args: { path: "a.txt" } });
    emitFor("background-a", "approval.requested", { approvalId: "a-approval", toolName: "read" });
    expect(useStore.getState().approvals).toEqual([]);
    useStore.getState().selectSession("background-a");
    expect(useStore.getState().running).toBe(true);
    expect(useStore.getState().activeRunId).toBe("background-a-run");
    expect(useStore.getState().toolCalls[0]?.toolCallId).toBe("a-tool");
    expect(useStore.getState().approvals[0]?.id).toBe("a-approval");
    expect(useStore.getState().streamingParts).toContainEqual(expect.objectContaining({ type: "text", text: "A-before-after" }));
    expect(JSON.stringify(useStore.getState().streamingParts)).toContain("A-reasoning");
    useStore.getState().newSession();
    emit({ type: "session.created", session: { id: "created-c", title: "New", workspaceId: "concurrent-workspace", createdAt: 1, updatedAt: 1 } });
    expect(useStore.getState().currentSessionId).toBe("created-c");
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().approvals).toEqual([]);
    emitFor("background-a", "tool.completed", { toolCallId: "a-tool", result: "ok" });
    useStore.getState().selectSession("background-b");
    expect(useStore.getState().streaming).toBe("B-only");
    expect(commands.slice(start).filter((command) => command.type === "agent.stop")).toEqual([]);
    useStore.getState().stopAgent();
    expect(commands.at(-1)).toMatchObject({ type: "agent.stop", runId: "background-b-run" });
    emitFor("background-b", "agent.cancelled");
    useStore.getState().selectSession("background-a");
    expect(useStore.getState().toolCalls[0]).toMatchObject({ status: "success", result: "ok" });
    expect(useStore.getState().running).toBe(true);
    emitFor("background-a", "agent.completed");
  } finally { useStore.setState(previous, true); }
});

test("a background completion saves its answer without stopping the foreground run", () => {
  const previous = useStore.getState();
  try {
    setupConcurrentSessions();
    startConcurrentRun("background-a");
    startConcurrentRun("background-b");
    emitFor("background-a", "agent.completed", { message: { id: "a-answer", role: "assistant", content: "A finished", runId: "background-a-run" } });
    expect(useStore.getState().currentSessionId).toBe("background-b");
    expect(useStore.getState().running).toBe(true);
    expect(useStore.getState().messages.some((message) => message.id === "a-answer")).toBe(false);
    expect(useStore.getState().runningSessionIds).not.toContain("background-a");
    useStore.getState().selectSession("background-a");
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().messages.at(-1)?.content).toBe("A finished");
    emitFor("background-b", "agent.failed", { message: "B failed" });
    expect(useStore.getState().chatRunError).toBeUndefined();
    useStore.getState().selectSession("background-b");
    expect(useStore.getState().chatRunError?.detail).toBe("B failed");
  } finally { useStore.setState(previous, true); }
});

test("a completed run is not revived by a run snapshot waiting for history", () => {
  const previous = useStore.getState();
  try {
    setupConcurrentSessions();
    startConcurrentRun("background-a");
    emitFor("background-a", "agent.completed");

    // The completion handler asks for both history and runs. Runs can arrive
    // first while the completed request is still retained for history merge.
    emit({ type: "session.runs", sessionId: "background-a", runs: [] });

    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().runningSessionIds).not.toContain("background-a");
  } finally { useStore.setState(previous, true); }
});

test("overlapping pending run requests keep errors and acknowledgements with their sessions", () => {
  const previous = useStore.getState();
  const start = commands.length;
  try {
    setupConcurrentSessions();
    useStore.getState().runAgent("A pending");
    useStore.getState().selectSession("background-b");
    useStore.getState().runAgent("B pending");
    const runs = commands.slice(start).filter((command) => command.type === "agent.run");
    expect(runs).toHaveLength(2);
    emit({ type: "error", requestId: runs[0]!.requestId, message: "A rejected" });
    expect(useStore.getState().running).toBe(true);
    expect(useStore.getState().chatRunError).toBeUndefined();
    useStore.getState().selectSession("background-a");
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().chatRunError?.detail).toBe("A rejected");
    emit({ type: "pong", requestId: runs[1]!.requestId });
    emit({ type: "session.runs", sessionId: "background-b", runs: [{ id: "background-b-run", sessionId: "background-b", status: "running", startedAt: 0 }] });
    useStore.getState().selectSession("background-b");
    expect(useStore.getState().activeRunId).toBe("background-b-run");
    emitFor("background-b", "agent.completed");
  } finally { useStore.setState(previous, true); }
});

test("a queued follow-up stays with its background session and starts after completion", async () => {
  const { createQoneMessageQueue } = await import("../src/lib/qone-message-queue");
  const { bindSessionQueue } = await import("../src/lib/session-queue-lifecycle");
  const { sessionStore } = await import("../src/lib/session-execution-state");
  const previous = useStore.getState();
  const start = commands.length;
  try {
    setupConcurrentSessions();
    startConcurrentRun("background-a");
    const queue = createQoneMessageQueue({
      sessionId: "background-a",
      isRunning: () => sessionStore(useStore, "background-a").getState().running,
      send: (_message, queueItemId) => useStore.getState().runAgent("queued for A", undefined, undefined, queueItemId, false, "background-a"),
      steer: async () => false, sync: () => {},
    });
    bindSessionQueue("background-a", queue);
    queue.adapter.enqueue({ role: "user", parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(), metadata: { custom: {} }, content: [{ type: "text", text: "queued for A" }], attachments: [] });
    await new Promise((resolve) => setTimeout(resolve, 0));
    startConcurrentRun("background-b");
    expect(commands.slice(start).filter((cmd) => cmd.type === "agent.run")).toHaveLength(2);
    emitFor("background-a", "agent.completed");
    await new Promise((resolve) => setTimeout(resolve, 0));
    const last = commands.slice(start).filter((cmd) => cmd.type === "agent.run").at(-1);
    expect(last).toMatchObject({ sessionId: "background-a", message: "queued for A" });
    expect(useStore.getState().currentSessionId).toBe("background-b");
    expect(useStore.getState().activeRunId).toBe("background-b-run");
    expect(useStore.getState().messages.at(-1)?.content).toBe("work on background-b");
    useStore.setState({ connected: false });
  } finally { useStore.setState(previous, true); }
});

test("a delayed transport failure clears only the pending background run", async () => {
  const previous = useStore.getState();
  let rejectSend: ((error: Error) => void) | undefined;
  try {
    setupConcurrentSessions();
    setSendFailure((command) => command.type === "agent.run" && command.sessionId === "background-a"
      ? new Promise<void>((_resolve, reject) => { rejectSend = reject; }) : Promise.resolve());
    useStore.getState().runAgent("A will fail");
    startConcurrentRun("background-b");
    rejectSend!(new Error("transport down"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(useStore.getState().running).toBe(true);
    expect(useStore.getState().activeRunId).toBe("background-b-run");
    expect(useStore.getState().runningSessionIds).not.toContain("background-a");
    useStore.getState().selectSession("background-a");
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().chatRunError?.detail).toContain("transport down");
    emitFor("background-b", "agent.completed");
  } finally { setSendFailure(undefined); useStore.setState(previous, true); }
});

test("late snapshots preserve a pending user turn and live background tools", () => {
  const previous = useStore.getState();
  try {
    setupConcurrentSessions();
    useStore.getState().runAgent("optimistic A");
    useStore.getState().newSessionInWorkspace("concurrent-workspace");
    expect(useStore.getState().currentSessionId).toBeUndefined();
    expect(useStore.getState().running).toBe(false);
    emit({ type: "session.messages", sessionId: "background-a", messages: [] });
    emit({ type: "session.runs", sessionId: "background-a", runs: [] });
    expect(useStore.getState().runningSessionIds).toContain("background-a");
    emitFor("background-a", "agent.started");
    emitFor("background-a", "tool.started", { toolCallId: "live-background-tool", toolName: "read" });
    emit({ type: "session.toolCalls", sessionId: "background-a", toolCalls: [] });
    useStore.getState().selectSession("background-a");
    expect(useStore.getState().messages.at(-1)?.content).toBe("optimistic A");
    expect(useStore.getState().toolCalls[0]?.toolCallId).toBe("live-background-tool");
    expect(useStore.getState().running).toBe(true);
    emitFor("background-a", "agent.completed");
  } finally { useStore.setState(previous, true); }
});

test("steer history atomically replaces transient tools before the delivered event", async () => {
  const { createQoneMessageQueue, getQoneMessageQueue, setQoneMessageQueue } = await import("../src/lib/qone-message-queue");
  const previous = useStore.getState();
  const oldQueue = getQoneMessageQueue("steer-history");
  const parts = [{ type: "tool-call" as const, toolCallId: "old", toolName: "read", args: {}, result: "done", messageSequence: 1 }];
  const queue = createQoneMessageQueue({ sessionId: "steer-history", isRunning: () => true,
    send: () => {}, steer: async () => true, sync: () => {},
  });
  try {
    useStore.setState({ currentSessionId: "steer-history", activeRunId: "steer-run", running: true,
      messages: [], streaming: "old text", streamingParts: parts, preparedToolCallIds: ["old"], activeMessageSequence: 1,
    });
    setQoneMessageQueue("steer-history", queue);
    queue.adapter.enqueue({ role: "user", parentId: null, sourceId: null, runConfig: {}, createdAt: new Date(),
      metadata: { custom: {} }, content: [{ type: "text", text: "new direction" }], attachments: [],
    });
    const localId = queue.adapter.items[0]!.id;
    const id = queue.getPersistentId(localId)!;
    queue.steerNow(localId);
    emit({ type: "session.messages", sessionId: "steer-history", messages: [
      { id: "previous-segment", sessionId: "steer-history", role: "assistant", content: "old text", parts, runId: "steer-run", createdAt: 1 },
      { id, sessionId: "steer-history", role: "user", content: "new direction", runId: "steer-run", createdAt: 2 },
    ] });
    expect(useStore.getState().messages.map((message) => message.id)).toEqual(["previous-segment", id]);
    expect(useStore.getState().streamingParts).toEqual([]);
    expect(useStore.getState().streaming).toBe("");
    expect(useStore.getState().activeMessageSequence).toBeUndefined();
    expect(useStore.getState().preparedToolCallIds).toEqual([]);
    expect(useStore.getState().running).toBe(true);
  } finally { setQoneMessageQueue("steer-history", oldQueue); useStore.setState(previous, true); }
});
