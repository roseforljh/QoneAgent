import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unlinkSync } from "node:fs";
import { closeDb, MessageRepo, openDb, SessionRepo } from "@qone/database";
import { decodeCommand, type MessageAttachmentInfo } from "@qone/protocol";
import { createPiSessionEntries, imageContent, promptWithAttachments } from "../src/pi-adapter";

const attachments: MessageAttachmentInfo[] = [
  { type: "file", name: "notes.txt", mimeType: "text/plain", data: "data:text/plain;base64,aGVsbG8=" },
  { type: "image", name: "plot.png", mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" },
];

test("attachment command validation and Pi transcript keep file text and image bytes", () => {
  const command = decodeCommand(JSON.stringify({ type: "agent.run", requestId: "r", sessionId: "s", message: "", attachments }));
  expect(command?.type).toBe("agent.run");
  expect(imageContent(attachments)).toEqual([{ type: "image", data: "aGVsbG8=", mimeType: "image/png" }]);
  expect(promptWithAttachments("read", attachments)).toContain('<attachment name="notes.txt">\nhello\n</attachment>');
  const entries = createPiSessionEntries("C:\\workspace", [{ role: "user", content: "read", attachments, createdAt: 1 }]);
  expect((entries[1] as { message: { content: unknown[] } }).message.content).toEqual([
    { type: "text", text: 'read\n\n<attachment name="notes.txt">\nhello\n</attachment>' },
    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
  ]);
});

test("existing SQLite conversations migrate and persist attachments", () => {
  const path = join(tmpdir(), `qone-attachments-${crypto.randomUUID()}.sqlite`);
  const old = new Database(path);
  old.exec("CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, run_id TEXT, role TEXT NOT NULL, content TEXT NOT NULL, model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)");
  old.close();
  try {
    const db = openDb(path);
    const session = new SessionRepo(db).create();
    new MessageRepo(db).add(session.id, "user", "read", undefined, undefined, undefined, attachments);
    const saved = new MessageRepo(db).listBySession(session.id)[0]!;
    expect(JSON.parse(saved.attachments!)).toEqual(attachments);
    closeDb(db);
  } finally {
    try { unlinkSync(path); } catch { /* SQLite may leave WAL files on Windows. */ }
  }
});
