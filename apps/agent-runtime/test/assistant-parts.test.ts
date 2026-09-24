import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo } from "@qone/database";
import { applyAssistantToolEvent, assistantPartsFromPiMessage } from "@qone/protocol";

test("Pi content-block order and message sequence survive a database reopen", () => {
    const db = openDb(":memory:");
    const session = new SessionRepo(db).create();
    const run = new RunRepo(db).create(session.id);
    const messages = new MessageRepo(db);
    const legacy = messages.addAssistant(session.id, "旧总结", run.id);
    const first = assistantPartsFromPiMessage({ message: { role: "assistant", content: [
      { type: "text", text: "先查" },
      { type: "toolCall", id: "call-a", name: "read", arguments: { path: "a" } },
      { type: "text", text: "再查" },
      { type: "toolCall", id: "call-b", name: "grep", arguments: { pattern: "b" } },
    ] } }, 10);
    const second = assistantPartsFromPiMessage({ message: { role: "assistant", content: [
      { type: "toolCall", id: "call-c", name: "ls", arguments: {} },
    ] } }, 20);
    const final = assistantPartsFromPiMessage({ message: { role: "assistant", content: [
      { type: "text", text: "完成" },
    ] } }, 30);
    const parts = applyAssistantToolEvent([...first, ...second, ...final], "tool.completed", {
      toolCallId: "call-a", result: { content: [{ type: "text", text: "ok" }] },
    });
    const saved = messages.addAssistant(session.id, "完成", run.id, undefined, parts);
    const snapshot = db.$client.serialize();
    closeDb(db);

    const reopened = openDb(":memory:", { open: () => Database.deserialize(snapshot) });
    const history = new MessageRepo(reopened).listBySession(session.id);
    expect(history.find((message) => message.id === legacy.id)).toMatchObject({ content: "旧总结", parts: null });
    expect(JSON.parse(history.find((message) => message.id === saved.id)!.parts!)).toEqual(parts);
    expect(parts.map((part) => part.type === "text" ? part.text : part.toolCallId)).toEqual([
      "先查", "call-a", "再查", "call-b", "call-c", "完成",
    ]);
    expect(parts.map((part) => part.messageSequence)).toEqual([10, 10, 10, 10, 20, 30]);
    closeDb(reopened);
});

test("bootstrap adds ordered parts to an existing messages table", () => {
  const sqlite = new Database(":memory:");
  sqlite.exec(`CREATE TABLE messages (
    id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL,
    content TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  ); INSERT INTO messages VALUES ('old', 'session', NULL, 'assistant', '旧内容', NULL, 1, 1);`);
  const db = openDb(":memory:", { open: () => sqlite });
  expect(new MessageRepo(db).listBySession("session")[0]).toMatchObject({ content: "旧内容", parts: null });
  closeDb(db);
});
