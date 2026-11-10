import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo, ToolCallRepo } from "@qone/database";
import { applyAssistantToolEvent, assistantPartsFromPiMessage } from "@qone/protocol";
import { createPiSessionEntries } from "../src/pi-attachments";

test("Pi content-block order and message sequence survive a database reopen", () => {
    const db = openDb(":memory:");
    const session = new SessionRepo(db).create();
    const run = new RunRepo(db).create(session.id);
    const messages = new MessageRepo(db);
    const legacy = messages.addAssistant(session.id, "旧总结", run.id);
    const first = assistantPartsFromPiMessage({ message: { role: "assistant", stopReason: "toolUse", content: [
      { type: "text", text: "先查" },
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
      { type: "text", text: "再查" },
      { type: "toolCall", id: "call-b", name: "grep", arguments: { pattern: "b" } },
    ] } }, 10);
    const second = assistantPartsFromPiMessage({ message: { role: "assistant", content: [
      { type: "toolCall", id: "call-c", name: "ls", arguments: {} },
    ] } }, 20);
    const final = assistantPartsFromPiMessage({ message: { role: "assistant", stopReason: "stop", content: [
      { type: "text", text: "完成" },
    ] } }, 30);
    const parts = applyAssistantToolEvent([...first, ...second, ...final], "tool.completed", {
      toolCallId: "call-a", result: { content: [{ type: "text", text: "ok" }] },
    });
    const saved = messages.addAssistant(session.id, "完成", run.id, undefined, parts, undefined, {
      role: "assistant", api: "openai-completions", provider: "test", model: "model-1",
      content: [{ type: "thinking", thinking: "reason" }, { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } }, { type: "text", text: "完成" }],
      usage: { input: 4, output: 5, totalTokens: 9, cost: { total: 0.01 } }, stopReason: "toolUse", timestamp: 42,
    });
    const snapshot = db.$client.serialize();
    closeDb(db);

    const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot) });
    const history = new MessageRepo(reopened).listBySession(session.id);
    expect(history.find((message) => message.id === legacy.id)).toMatchObject({ content: "旧总结", parts: null });
    expect(JSON.parse(history.find((message) => message.id === saved.id)!.parts!)).toEqual(parts);
    const raw = JSON.parse(history.find((message) => message.id === saved.id)!.rawMessage!);
    expect(raw.usage.totalTokens).toBe(9);
    expect(raw.stopReason).toBe("toolUse");
    expect(raw.content[0].type).toBe("thinking");
    expect(raw.content[1].id).toBe("call-a");
    expect(parts.map((part) => part.type === "text" ? part.text : part.toolCallId)).toEqual([
      "先查", "call-a", "再查", "call-b", "call-c", "完成",
    ]);
    expect(parts.map((part) => part.messageSequence)).toEqual([10, 10, 10, 10, 20, 30]);
    expect(parts.filter((part) => part.type === "text").map((part) => part.phase)).toEqual(["commentary", "commentary", "final_answer"]);
    closeDb(reopened);
});

test("bootstrap adds ordered parts to an existing messages table", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL,
    content TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); INSERT INTO messages VALUES ('old', 'session', NULL, 'assistant', '旧内容', NULL, 1, 1);`);
  const db = openDb(":memory:", { open: () => sqlite });
  expect(new MessageRepo(db).listBySession("session")[0]).toMatchObject({ content: "旧内容", parts: null, rawMessage: null });
  closeDb(db);
});

test("a response before finalization is persisted as commentary", () => {
  const parts = assistantPartsFromPiMessage({ message: {
    role: "assistant", stopReason: "stop", content: [{ type: "text", text: "先处理子代理结果" }],
  } }, 4, "commentary");
  expect(parts).toEqual([{ type: "text", text: "先处理子代理结果", messageSequence: 4, phase: "commentary" }]);
});

test("raw user, tool result and assistant messages restore one ordered Pi transcript", () => {
  const rawUser = { role: "user", content: "读文件", timestamp: 1 };
  const rawToolCall = { role: "assistant", api: "openai-completions", provider: "test", model: "m1", stopReason: "toolUse",
    content: [{ type: "toolCall", id: "call-1", name: "read", arguments: { path: "a" } }], timestamp: 2 };
  const rawToolResult = { role: "toolResult", toolCallId: "call-1", toolName: "read", isError: false,
    content: [{ type: "text", text: "file body" }], timestamp: 3 };
  const rawFinal = { role: "assistant", api: "openai-completions", provider: "test", model: "m1", stopReason: "stop",
    content: [{ type: "text", text: "完成" }], timestamp: 4 };

  const entries = createPiSessionEntries("C:/work/app", [
    { role: "user", content: "读文件", createdAt: 1, rawMessage: rawUser },
    { role: "assistant", content: "完成", createdAt: 4, rawMessage: [rawToolCall, rawToolResult, rawFinal] },
  ], { api: "openai-completions", provider: "test", id: "m1" });

  expect(entries).toHaveLength(5);
  expect(entries.slice(1).map((entry) => entry.type === "message" ? entry.message : undefined))
    .toEqual([rawUser, rawToolCall, rawToolResult, rawFinal]);
  // Parent ids must chain so Pi can replay the branch linearly.
  const ids = entries.slice(1).map((entry) => entry.type === "message" ? entry.id : undefined);
  expect(entries.slice(2).map((entry) => entry.type === "message" ? entry.parentId : undefined))
    .toEqual(ids.slice(0, -1));
});

test("tool call duration survives a database reopen", () => {
  const db = openDb(":memory:");
  const session = new SessionRepo(db).create();
  const run = new RunRepo(db).create(session.id);
  const tools = new ToolCallRepo(db);
  const started = tools.start(run.id, "powershell", { command: "echo" }, "pi-call");
  tools.finish(started.id, "success", { content: [{ type: "text", text: "ok" }] }, 1234);
  const snapshot = db.$client.serialize();
  closeDb(db);

  const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot) });
  expect(new ToolCallRepo(reopened).listBySession(session.id)[0]).toMatchObject({ durationMs: 1234, status: "success" });
  closeDb(reopened);
});

test("bootstrap adds duration_ms and raw_message to an existing schema", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL,
    content TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE runs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'created',
    started_at INTEGER, completed_at INTEGER, error TEXT);
  CREATE TABLE tool_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, tool_name TEXT NOT NULL,
    arguments TEXT, result_summary TEXT, status TEXT NOT NULL DEFAULT 'queued', started_at INTEGER, completed_at INTEGER);
  INSERT INTO runs (id, session_id, status) VALUES ('run', 'session', 'running');
  INSERT INTO tool_calls (id, run_id, tool_name, status, started_at) VALUES ('run:old', 'run', 'read', 'running', 1);`);
  const db = openDb(":memory:", { open: () => sqlite });
  const tools = new ToolCallRepo(db);
  expect(tools.listBySession("session")[0]).toMatchObject({ id: "run:old", durationMs: null });
  tools.finish("run:old", "cancelled", undefined, 42);
  expect(tools.listBySession("session")[0]?.durationMs).toBe(42);
  closeDb(db);
});
