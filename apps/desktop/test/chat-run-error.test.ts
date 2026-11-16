import { beforeEach, expect, test } from "bun:test";
import type { AgentEvent } from "@qone/protocol";
import { assistantMessageContent } from "../src/lib/assistant-message-parts";
import { switchSessionState } from "../src/lib/session-execution-state";
import { createQoneMessageQueue } from "../src/lib/qone-message-queue";
import { bindSessionQueue, hydrateSessionQueue } from "../src/lib/session-queue-lifecycle";
import { commands, emit, event, requestModelMetadata, resetHarness, setSendFailure, storage, useStore } from "./helpers/chat-store-harness";

beforeEach(() => { resetHarness(); });

test("ordinary commands and direct model metadata requests use the current UI language", async () => {
  const { GENERAL_SETTINGS_KEY } = await import("../src/localization");
  const previous = useStore.getState();
  const previousSettings = storage.get(GENERAL_SETTINGS_KEY);
  const pingId = crypto.randomUUID();
  try {
    await useStore.getState().send({ type: "ping", requestId: pingId });
    emit({ type: "pong", requestId: pingId, capabilities: ["model.resolve-metadata", "model.metadata-sources"] });
    for (const locale of ["en", "zh-CN"] as const) {
      storage.set(GENERAL_SETTINGS_KEY, JSON.stringify({ language: locale }));
      await useStore.getState().send({ type: "session.list", requestId: crypto.randomUUID(), locale: locale === "en" ? "zh-CN" : "en" });
      expect(commands.at(-1)?.locale).toBe(locale);
      const pending = requestModelMetadata({ provider: "test", apiType: "openai-compatible", baseUrl: "https://example.com", models: [{ id: "test" }], locale: locale === "en" ? "zh-CN" : "en" });
      const command = commands.at(-1)!;
      expect(command.type).toBe("model.resolve-metadata");
      expect(command.locale).toBe(locale);
      emit({ type: "model.metadata-resolved", requestId: command.requestId, models: [] });
      expect(await pending).toEqual([]);
      useStore.setState({ connected: false });
      await expect(requestModelMetadata({ provider: "test", apiType: "openai-compatible", baseUrl: "https://example.com", models: [{ id: "test" }] })).rejects.toThrow(locale === "en" ? "Runtime is not connected" : "运行时未连接");
      useStore.setState({ connected: true });
    }
  } finally {
    if (previousSettings === undefined) storage.delete(GENERAL_SETTINGS_KEY);
    else storage.set(GENERAL_SETTINGS_KEY, previousSettings);
    useStore.setState(previous, true);
  }
});

test("child deltas preserve transcript references, route to the parent session, and settle with a full snapshot", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ currentSessionId: "session-a", subagents: [], backgroundSessions: {} });
    const child = {
      id: "child-a", parentSessionId: "session-a", parentRunId: "parent-a", toolCallId: "call-a",
      title: "Child", task: "Task", status: "running" as const, startedAt: 1, content: "",
      parts: [], messages: [{ id: "task", sequence: 0, role: "user" as const, content: "Task", createdAt: 1 }],
    };
    emit({ type: "subagent.updated", subagent: child });
    const saved = useStore.getState().subagents[0]!;
    emit({ type: "subagent.streaming", sessionId: "session-a", id: "child-a", delta: "你好" });
    emit({ type: "subagent.streaming", sessionId: "session-a", id: "child-a", delta: "!" });
    expect(useStore.getState().subagents[0]).toMatchObject({ streaming: "你好!" });
    expect(useStore.getState().subagents[0]!.parts).toBe(saved.parts);
    expect(useStore.getState().subagents[0]!.messages).toBe(saved.messages);
    emit({ type: "subagent.streaming", sessionId: "session-a", id: "child-a", delta: "", reasoning: [
      { delta: "分析", messageSequence: 2, contentIndex: 0 },
      { delta: "完成", messageSequence: 2, contentIndex: 0, complete: true },
    ] });
    expect(useStore.getState().subagents[0]!.parts).toEqual([
      { type: "reasoning", text: "分析完成", messageSequence: 2, contentIndex: 0, complete: true },
    ]);
    expect(useStore.getState().subagents[0]!.streaming).toBe("你好!");
    expect(useStore.getState().subagents[0]!.messages).toBe(saved.messages);
    const beforeUnknown = useStore.getState();
    emit({ type: "subagent.streaming", sessionId: "session-a", id: "unknown", delta: "ignored" });
    expect(useStore.getState()).toBe(beforeUnknown);
    useStore.setState({ ...switchSessionState(useStore.getState(), "session-b"), currentSessionId: "session-b" });
    emit({ type: "subagent.streaming", sessionId: "session-a", id: "child-a", delta: "background" });
    expect(useStore.getState().subagents).toEqual([]);
    expect(useStore.getState().backgroundSessions["session-a"]?.subagents[0]?.streaming).toBe("你好!background");
    emit({ type: "subagent.updated", subagent: { ...child, status: "completed", content: "你好!background" } });
    expect(useStore.getState().backgroundSessions["session-a"]?.subagents[0]?.streaming).toBeUndefined();
    expect(useStore.getState().backgroundSessions["session-a"]?.subagents[0]?.messages).toEqual(child.messages);
  } finally { useStore.setState(previous, true); }
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
      { id: "preset", name: "Preset", connected: true, connecting: false, toolCount: 3 },
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

test("uses runtime connection snapshots without restoring credentials from the renderer", async () => {
  const start = commands.length;
  emit({ type: "mcp.list", servers: [{
    id: "mcp-key-restore", name: "Key test", command: "npx", connected: false, connecting: true,
    env: { TEST_API_KEY: "$mcp.env:mcp-key-restore/TEST_API_KEY" },
  }] });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(commands.slice(start).some(cmd => cmd.type === "secret.set")).toBe(false);
  expect(useStore.getState().mcpConnectingIds).toContain("mcp-key-restore");
  emit({ type: "mcp.list", servers: [{ id: "mcp-key-restore", name: "Key test", command: "npx", connected: false, connecting: false }] });
  expect(useStore.getState().mcpConnectingIds).not.toContain("mcp-key-restore");
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

test("new-session draft requires an imported selected workspace and stays available during another run", () => {
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
    expect(commands.slice(start).filter((command) => command.type === "session.create")).toHaveLength(0);
    expect(useStore.getState().draftWorkspaceId).toBe(workspace.id);
    expect(useStore.getState().currentSessionId).toBeUndefined();

    useStore.setState({ running: false });
    useStore.getState().newSession();
    expect(commands.slice(start).filter((command) => command.type === "session.create")).toHaveLength(0);
    expect(useStore.getState().draftWorkspaceId).toBe(workspace.id);

    useStore.getState().newSessionInWorkspace(workspace.id);
    expect(useStore.getState().draftWorkspaceId).toBe(workspace.id);
    useStore.getState().createSessionForWorkspace(workspace.id);
    expect(commands.filter((command) => command.type === "session.create").slice(-1)).toEqual([
      expect.objectContaining({ workspaceId: workspace.id }),
    ]);
  } finally {
    useStore.setState(previous, true);
  }
});

test("switching sessions while one is running keeps the run alive", () => {
  const previous = useStore.getState();
  const start = commands.length;
  try {
    useStore.setState({
      currentSessionId: "session-1",
      currentWorkspaceId: "workspace-1",
      sessions: [
        { id: "session-1", title: "Running", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 },
        { id: "session-2", title: "Other", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 },
      ],
      running: true,
      activeRunId: "run-1",
    });

    useStore.getState().selectSession("session-2");

    expect(useStore.getState().currentSessionId).toBe("session-2");
    expect(useStore.getState().running).toBe(false);
    expect(commands.slice(start)).toEqual(expect.arrayContaining([
      expect.objectContaining({ type: "session.messages", sessionId: "session-2" }),
      expect.objectContaining({ type: "session.runs", sessionId: "session-2" }),
    ]));

    emit({ type: "agent.event", event: { ...event("agent.completed", {}), sessionId: "session-1", runId: "run-1" } });
    expect(useStore.getState().currentSessionId).toBe("session-2");
    expect(useStore.getState().running).toBe(false);
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

test("resending after a failed reply merges the user turn and starts execution again", () => {
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

  useStore.getState().runAgent("hello");
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

test("continuing after a failed reply keeps the previous turn and starts a follow-up", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      currentSessionId: "session-1",
      sessions: [{ id: "session-1", title: "Test", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
      workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
      messages: [], running: false, activeRunId: undefined, chatRunError: undefined,
    });
    useStore.getState().runAgent("原始任务");
    const originalId = useStore.getState().messages[0]?.id;
    emit({ type: "agent.event", event: event("agent.started", { runId: "run-1" }) });
    emit({ type: "agent.event", event: event("agent.failed", { message: "stream ended" }) });

    useStore.getState().runAgent("继续", undefined, undefined, undefined, undefined, undefined, undefined, true);
    const continuation = commands.filter((command) => command.type === "agent.run").at(-1);
    expect(continuation?.type).toBe("agent.run");
    const messages = useStore.getState().messages;
    expect(messages).toHaveLength(2);
    expect(messages[0]).toMatchObject({ id: originalId, content: "原始任务" });
    expect(messages[1]).toMatchObject({ content: "继续" });
    if (continuation?.type === "agent.run") {
      expect(continuation.replaceFromMessageId).toBeUndefined();
      expect(continuation.continuation).toBe(true);
    }
  } finally {
    useStore.setState(previous, true);
  }
});

test("retry of a rejected optimistic turn sends a new message without replacing an unsaved id", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      currentSessionId: "session-1",
      sessions: [{ id: "session-1", title: "Test", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
      workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
      messages: [], running: false, activeRunId: undefined, chatRunError: undefined,
    });
    useStore.getState().runAgent("queued reply");
    const rejected = commands.filter((command) => command.type === "agent.run").at(-1);
    expect(rejected?.type).toBe("agent.run");
    if (rejected?.type !== "agent.run") return;
    emit({ type: "error", requestId: rejected.requestId, message: "session already has an active run" });
    expect(useStore.getState().messages.at(-1)?.persisted).toBe(false);

    const rejectedId = useStore.getState().chatRunError?.userMessageId;
    expect(rejectedId).toBe(rejected.messageId);
    useStore.getState().runAgent("queued reply");
    const retry = commands.filter((command) => command.type === "agent.run").at(-1);
    expect(retry?.type).toBe("agent.run");
    if (retry?.type !== "agent.run") return;
    expect(retry.messageId).not.toBe(rejectedId);
    expect(retry.replaceFromMessageId).toBeUndefined();
    expect(useStore.getState().messages.map((message) => message.id)).toEqual([retry.messageId]);
  } finally {
    useStore.setState(previous, true);
  }
});

test("stopping the first run clears a title spinner even when title generation never replies", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      currentSessionId: "session-1",
      sessions: [{ id: "session-1", title: "New session", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
      workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
      messages: [],
      runs: [],
      running: false,
      activeRunId: undefined,
      titleGeneratingSessionIds: [],
    });
    useStore.getState().runAgent("hello");
    expect(useStore.getState().titleGeneratingSessionIds).toContain("session-1");
    emit({ type: "agent.event", event: event("agent.started", { runId: "run-1" }) });
    emit({ type: "agent.event", event: event("agent.cancelled", {}) });
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().titleGeneratingSessionIds).not.toContain("session-1");
  } finally {
    useStore.setState(previous, true);
  }
});

test("a failed title request clears its spinner", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      currentSessionId: "session-1",
      sessions: [{ id: "session-1", title: "New session", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
      workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
      messages: [],
      running: false,
      titleGeneratingSessionIds: [],
    });
    useStore.getState().runAgent("hello");
    const titleRequest = commands.filter((command) => command.type === "session.generate-title").at(-1);
    expect(titleRequest?.type).toBe("session.generate-title");
    if (titleRequest?.type !== "session.generate-title") return;
    emit({ type: "error", requestId: titleRequest.requestId, message: "title unavailable" });
    expect(useStore.getState().titleGeneratingSessionIds).not.toContain("session-1");
  } finally {
    useStore.setState(previous, true);
  }
});

test("an active run snapshot fills in the run id while the optimistic UI is already running", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ currentSessionId: "session-1", running: true, activeRunId: undefined, runs: [] });
    emit({ type: "session.runs", sessionId: "session-1", runs: [{ id: "run-1", sessionId: "session-1", status: "running", startedAt: 1 }] });
    expect(useStore.getState().activeRunId).toBe("run-1");
    expect(useStore.getState().running).toBe(true);
  } finally {
    useStore.setState(previous, true);
  }
});

test("a stale history snapshot does not remove the optimistic user turn after pong", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({
      currentSessionId: "session-optimistic-history",
      sessions: [{ id: "session-optimistic-history", title: "Test", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
      workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
      messages: [], running: false, activeRunId: undefined,
    });
    useStore.getState().runAgent("hello");
    const command = commands.filter((item) => item.type === "agent.run").at(-1)!;
    expect(command.type).toBe("agent.run");
    if (command.type !== "agent.run") return;
    const optimisticId = command.messageId;

    emit({ type: "pong", requestId: command.requestId });
    expect(useStore.getState().messages.map((message) => message.id)).toEqual([optimisticId]);

    // This is the old snapshot race: the runtime accepted the run, but has not
    // committed the user row before the history query returns.
    emit({ type: "session.messages", sessionId: "session-optimistic-history", messages: [] });
    expect(useStore.getState().messages.map((message) => message.id)).toEqual([optimisticId]);

    emit({ type: "session.messages", sessionId: "session-optimistic-history", messages: [
      { id: optimisticId, sessionId: "session-optimistic-history", role: "user", content: "hello", createdAt: 1 },
    ] });
    expect(useStore.getState().messages).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: optimisticId, persisted: true }),
    ]));

    // A second, older response must not remove it before the run reaches a
    // terminal event, even though the first response already contained it.
    emit({ type: "session.messages", sessionId: "session-optimistic-history", messages: [] });
    expect(useStore.getState().messages.map((message) => message.id)).toEqual([optimisticId]);
  } finally {
    useStore.setState(previous, true);
  }
});

test("a late completion snapshot cannot remove the next submitted user turn", () => {
  const previous = useStore.getState();
  try {
    const sessionId = "session-consecutive-turns";
    useStore.setState({
      currentSessionId: sessionId,
      sessions: [{ id: sessionId, title: "Test", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
      workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
      messages: [], running: false, activeRunId: undefined, chatRunError: undefined,
    });

    useStore.getState().runAgent("first");
    const first = commands.filter((item) => item.type === "agent.run").at(-1)!;
    expect(first.type).toBe("agent.run");
    if (first.type !== "agent.run") return;
    emit({ type: "agent.event", event: { ...event("agent.started"), sessionId, runId: "first-run" } });
    emit({ type: "agent.event", event: { ...event("agent.completed", {}), sessionId, runId: "first-run", payload: { message: { id: "first-answer", role: "assistant", content: "first answer", runId: "first-run", createdAt: 2 } } } });

    const completionSnapshot = commands.filter((item) => item.type === "session.messages").at(-1)!;
    expect(completionSnapshot?.type).toBe("session.messages");

    useStore.getState().runAgent("second");
    const second = commands.filter((item) => item.type === "agent.run").at(-1)!;
    expect(second.type).toBe("agent.run");
    if (second.type !== "agent.run") return;

    emit({ type: "session.messages", requestId: completionSnapshot.requestId, sessionId, messages: [
      { id: first.messageId, sessionId, role: "user", content: "first", createdAt: 1 },
      { id: "first-answer", sessionId, role: "assistant", content: "first answer", runId: "first-run", createdAt: 2 },
    ] });

    expect(useStore.getState().messages.map((message) => message.id)).toEqual([first.messageId, "first-answer", second.messageId]);
  } finally {
    useStore.setState(previous, true);
  }
});

test("accepted agent run requests a run snapshot when the start event is missed", () => {
  const previous = useStore.getState();
  const start = commands.length;
  try {
    useStore.setState({
      currentSessionId: "session-1",
      sessions: [{ id: "session-1", title: "Test", workspaceId: "workspace-1", createdAt: 0, updatedAt: 0 }],
      workspaces: [{ id: "workspace-1", name: "Test", path: "C:/test", createdAt: 0, updatedAt: 0 }],
      messages: [], running: false, activeRunId: undefined,
    });
    useStore.getState().runAgent("hello");
    const runCommand = commands.slice(start).find((command) => command.type === "agent.run");
    expect(runCommand?.type).toBe("agent.run");
    if (runCommand?.type !== "agent.run") return;
    emit({ type: "pong", requestId: runCommand.requestId });
    expect(commands.slice(start)).toContainEqual(expect.objectContaining({ type: "session.runs", sessionId: "session-1" }));
    emit({ type: "session.runs", sessionId: "session-1", runs: [{ id: "run-1", sessionId: "session-1", status: "running", startedAt: 1 }] });
    expect(useStore.getState().activeRunId).toBe("run-1");
  } finally {
    useStore.setState(previous, true);
  }
});

test("stop requested before run id arrives is sent once the run starts", async () => {
  const previous = useStore.getState();
  const start = commands.length;
  try {
    useStore.setState({ currentSessionId: "session-1", running: true, activeRunId: undefined, runs: [] });
    useStore.getState().stopAgent();
    expect(commands.slice(start)).toContainEqual(expect.objectContaining({ type: "session.runs", sessionId: "session-1" }));
    emit({ type: "agent.event", event: event("agent.started", { runId: "run-1" }) });
    emit({ type: "session.runs", sessionId: "session-1", runs: [{ id: "run-1", sessionId: "session-1", status: "running", startedAt: 1 }] });
    await Promise.resolve();
    expect(commands.slice(start).filter((command) => command.type === "agent.stop")).toEqual([
      expect.objectContaining({ runId: "run-1" }),
    ]);
    emit({ type: "agent.event", event: event("agent.cancelled", {}) });
  } finally {
    useStore.setState(previous, true);
  }
});

const tick = () => new Promise<void>(resolve => setImmediate(resolve));
test("IPC rejection restores the queued input exactly once and leaves later inputs waiting", async () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ connected: true, currentSessionId: "ipc-queue", running: false, activeRunId: undefined, messages: [],
      sessions: [{ id: "ipc-queue", title: "IPC", workspaceId: "workspace", createdAt: 1, updatedAt: 1 }],
      workspaces: [{ id: "workspace", name: "Test", path: "C:/test", createdAt: 1, updatedAt: 1 }] });
    const queue = createQoneMessageQueue({ sessionId: "ipc-queue", isRunning: () => useStore.getState().running,
      steer: async () => false, sync: () => {}, send: (message, id, attachments) => useStore.getState().runAgent(
        message.content[0]?.type === "text" ? message.content[0].text : "", undefined, attachments, id),
    });
    hydrateSessionQueue(queue, []); bindSessionQueue("ipc-queue", queue);
    setSendFailure(async command => { if (command.type === "agent.run") throw new Error("pipe closed"); });
    const input = (text: string) => ({ role: "user" as const, parentId: null, sourceId: null, runConfig: {}, content: [{ type: "text" as const, text }], attachments: [] });
    queue.adapter.enqueue(input("first")); queue.adapter.enqueue(input("second"));
    await tick();
    expect(commands.filter(command => command.type === "agent.run")).toHaveLength(1);
    expect(queue.adapter.items.map(item => item.prompt)).toEqual(["first", "second"]);
    expect(useStore.getState().running).toBe(false);
    setSendFailure(undefined);
    queue.steerNow(queue.adapter.items[0]!.id);
    await tick();
    expect(commands.filter(command => command.type === "agent.run")).toHaveLength(2);
    expect(queue.adapter.items.map(item => item.prompt)).toEqual(["second"]);
  } finally { setSendFailure(undefined); useStore.setState({ connected: false }); useStore.setState(previous, true); }
});

test("a background stop IPC failure clears only its owner's stopping state", async () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ connected: true, currentSessionId: "selected", running: false, activeRunId: undefined, lastError: undefined,
      backgroundSessions: { owner: { running: true, activeRunId: "owner-run", stoppingRunId: undefined } } });
    setSendFailure(async command => { if (command.type === "agent.stop") throw new Error("stop pipe closed"); });
    useStore.getState().stopAgent("owner");
    await tick();
    expect(useStore.getState().lastError).toContain("stop pipe closed");
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().activeRunId).toBeUndefined();
    expect(useStore.getState().backgroundSessions.owner?.running).toBe(true);
    expect(useStore.getState().backgroundSessions.owner?.stoppingRunId).toBeUndefined();
    expect(commands).toContainEqual(expect.objectContaining({ type: "session.runs", sessionId: "owner" }));
  } finally { setSendFailure(undefined); useStore.setState(previous, true); }
});

test("a terminal run snapshot clears stopping state and keeps the next stop cooperative", () => {
  const previous = useStore.getState();
  try {
    useStore.setState({ currentSessionId: "reconciled-stop", running: true, activeRunId: "old", stoppingRunId: undefined });
    useStore.getState().stopAgent();
    emit({ type: "session.runs", sessionId: "reconciled-stop", runs: [{ id: "old", sessionId: "reconciled-stop", status: "cancelled", startedAt: 1 }] });
    expect(useStore.getState().running).toBe(false);
    expect(useStore.getState().stoppingRunId).toBeUndefined();
    useStore.setState({ running: true, activeRunId: "new" });
    useStore.getState().stopAgent();
    expect(commands.filter(command => command.type === "agent.stop").at(-1)).toMatchObject({ runId: "new" });
    expect(commands.filter(command => command.type === "agent.stop").at(-1)).not.toHaveProperty("force");
    emit({ type: "agent.event", event: { ...event("agent.cancelled", {}), sessionId: "reconciled-stop", runId: "new" } });
  } finally { useStore.setState(previous, true); }
});

test("authoritative session lists prune deleted queue pause keys but preserve live main and side chats", () => {
  const previous = useStore.getState();
  try {
    for (const id of ["deleted", "kept", "side"]) storage.set(`qone:queue-paused:${id}`, "1");
    storage.set("unrelated-setting", "keep");
    useStore.setState({ currentSessionId: "kept", backgroundSessions: {}, sideChats: {} });
    emit({ type: "session.list", sessions: [{ id: "kept", title: "K", createdAt: 1, updatedAt: 1 }],
      sideChats: [{ id: "side", title: "S", createdAt: 1, updatedAt: 1 }] });
    expect(storage.has("qone:queue-paused:deleted")).toBe(false);
    expect(storage.get("qone:queue-paused:kept")).toBe("1");
    expect(storage.get("qone:queue-paused:side")).toBe("1");
    expect(storage.get("unrelated-setting")).toBe("keep");
  } finally { for (const id of ["deleted", "kept", "side"]) storage.delete(`qone:queue-paused:${id}`); storage.delete("unrelated-setting"); useStore.setState(previous, true); }
});
