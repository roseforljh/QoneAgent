import { expect, test } from "bun:test";
import { closeDb, MessageRepo, openDb, QueueRepo, RunRepo, SessionRepo, SettingsRepo, WorkspaceRepo } from "@qone/database";
import { decodeCommand, type QueueItemInfo } from "@qone/protocol";
import { SideConversationService, SIDE_CHAT_BOUNDARY, SIDE_CHAT_INSTRUCTIONS } from "../src/side-conversation";

function fixture() {
  const db = openDb(":memory:");
  const settings = new SettingsRepo(db); const queue = new QueueRepo(settings);
  const workspace = new WorkspaceRepo(db).upsert("project", "C:\\repo");
  const parent = new SessionRepo(db).create("parent", workspace.id);
  const input: QueueItemInfo = { id: "input", sessionId: parent.id, text: "ask in side chat", lane: "queue", status: "scheduled", position: 0, createdAt: 1, updatedAt: 1,
    attachments: [{ type: "file", name: "source.txt", mimeType: "text/plain", data: "data:text/plain;base64,YQ==", localPath: "C:\\repo\\source.txt" }] };
  const next = { ...input, id: "next", text: "next parent input", position: 1 };
  queue.replace(parent.id, [input, next]);
  return { db, settings, queue, parent, input, next, service: new SideConversationService(db) };
}

test("side chat inherits a snapshot with an authorization boundary and owns the complete transferred input", () => {
  const f = fixture();
  try {
    const messages = new MessageRepo(f.db);
    messages.add(f.parent.id, "user", "old task"); messages.add(f.parent.id, "assistant", "old answer");
    const parentRun = new RunRepo(f.db).create(f.parent.id);
    const child = f.service.create(f.parent.id, f.input.id);
    expect(child.workspaceId).toBe(f.parent.workspaceId);
    expect(child.sideChat?.parentSessionId).toBe(f.parent.id);
    expect(messages.listBySession(child.id).map((item) => item.content)).toEqual(["old task", "old answer", SIDE_CHAT_BOUNDARY]);
    expect(messages.listBySession(child.id).at(-1)?.id).toBe(child.sideChat?.boundaryMessageId);
    messages.add(f.parent.id, "assistant", "later parent answer");
    expect(messages.listBySession(child.id)).toHaveLength(3);
    expect(new RunRepo(f.db).get(parentRun.id)?.status).toBe(parentRun.status);
    expect(f.queue.list(f.parent.id).map((item) => item.id)).toEqual(["next"]);
    const transferred = f.queue.list(child.id)[0]!;
    expect(transferred.id).not.toBe(f.input.id);
    expect(transferred.attachments).toEqual(f.input.attachments);
    expect(transferred.text).toBe(f.input.text);
    expect(transferred.status).toBe("queued");
    expect(SIDE_CHAT_INSTRUCTIONS).toContain("Sub-agents are off-limits");
  } finally { closeDb(f.db); }
});

test("transfer retries and stale source snapshots cannot create a duplicate across repository restarts", () => {
  const f = fixture();
  try {
    const child = f.service.create(f.parent.id, f.input.id);
    expect(new SideConversationService(f.db).create(f.parent.id, f.input.id).id).toBe(child.id);
    const restarted = new QueueRepo(new SettingsRepo(f.db));
    restarted.replace(f.parent.id, [f.input, f.next]); restarted.upsert(f.input);
    expect(restarted.list(f.parent.id).map((item) => item.id)).toEqual(["next"]);
    expect(new SessionRepo(f.db).list()).toHaveLength(2);
    expect(restarted.list(child.id)).toHaveLength(1);
  } finally { closeDb(f.db); }
});

test("a failure partway through forking rolls back the child and leaves source ownership intact", () => {
  const f = fixture();
  try {
    new MessageRepo(f.db).add(f.parent.id, "user", "history");
    f.db.$client.exec("UPDATE messages SET attachments = 'invalid json'");
    expect(() => f.service.create(f.parent.id, f.input.id)).toThrow();
    expect(new SessionRepo(f.db).list()).toHaveLength(1);
    expect(f.queue.list(f.parent.id).map((item) => item.id)).toEqual(["input", "next"]);
    expect(f.settings.get(`queue:transferred:${f.parent.id}:${f.input.id}`)).toBeUndefined();
  } finally { closeDb(f.db); }
});

test("side chats reject nested forks and inputs already owned by a steer", () => {
  const f = fixture();
  try {
    const child = f.service.create(f.parent.id, f.input.id);
    expect(() => f.service.create(child.id, f.queue.list(child.id)[0]!.id)).toThrow("cannot open another");
    f.queue.upsert({ ...f.next, lane: "steer", status: "steering" });
    expect(() => f.service.create(f.parent.id, f.next.id)).toThrow("no longer available");
    expect(f.queue.list(f.parent.id)[0]?.lane).toBe("steer");
  } finally { closeDb(f.db); }
});

test("the side chat protocol requires both source conversation and input identity", () => {
  expect(decodeCommand(JSON.stringify({ type: "session.side-chat.create", requestId: "r", sessionId: "s", queueItemId: "q" }))?.type).toBe("session.side-chat.create");
  expect(decodeCommand(JSON.stringify({ type: "session.side-chat.create", requestId: "r", sessionId: "s" }))).toBeNull();
});
