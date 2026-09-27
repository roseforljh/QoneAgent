import { expect, test } from "bun:test";
import { closeDb, openDb, QueueRepo, SessionRepo, SettingsRepo } from "@qone/database";
import { decodeCommand, type QueueItemInfo } from "@qone/protocol";

const item = (sessionId: string, id: string, text: string, position: number): QueueItemInfo => ({
  id, sessionId, text, lane: "queue", status: "queued", position,
  createdAt: position + 1, updatedAt: position + 1,
});

test("queued messages persist their order and attachments without entering history", () => {
  const db = openDb(":memory:");
  const session = new SessionRepo(db).create();
  const repo = new QueueRepo(new SettingsRepo(db));
  const first = item(session.id, "q-a", "A", 0);
  const second = { ...item(session.id, "q-b", "B", 1), attachments: [{ type: "file" as const, name: "a.txt", mimeType: "text/plain", data: "data:text/plain;base64,Yg==" }] };

  repo.replace(session.id, [second, first]);
  expect(repo.list(session.id).map((entry) => entry.text)).toEqual(["A", "B"]);
  expect(repo.list(session.id)[1]!.attachments).toEqual(second.attachments);
  expect(new SessionRepo(db).get(session.id)).toBeDefined();
  closeDb(db);
});

test("queue protocol accepts sync and steer commands", () => {
  const queued = item("s", "q", "continue", 0);
  expect(decodeCommand(JSON.stringify({ type: "queue.sync", requestId: "r", sessionId: "s", items: [queued] }))?.type).toBe("queue.sync");
  expect(decodeCommand(JSON.stringify({ type: "agent.steer", requestId: "r", sessionId: "s", runId: "run", queueItemId: "q", message: "focus" }))?.type).toBe("agent.steer");
});
