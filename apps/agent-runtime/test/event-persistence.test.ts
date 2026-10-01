import { describe, expect, spyOn, test } from "bun:test";
import { EventRepo, MessageRepo, RunRepo, SessionRepo, openDb } from "@qone/database";
import { SequencedEventJournal } from "@qone/shared";

describe("persistent event journal", () => {
  test("current markers skip history parsing while legacy automatic markers recover their position", () => {
    const db = openDb(":memory:");
    const history = spyOn(MessageRepo.prototype, "listBySession");
    try {
      const session = new SessionRepo(db).create("markers");
      const run = new RunRepo(db).create(session.id);
      new MessageRepo(db).addAssistant(session.id, "answer", run.id, undefined, [
        { type: "reasoning", text: "reason", messageSequence: 1 },
        { type: "text", text: "answer", messageSequence: 1 },
        { type: "text", text: "later", messageSequence: 5 },
      ]);
      const repo = new EventRepo(db);
      expect(repo.listCompactions(session.id)).toEqual([]);
      const payload = { id: "current", throughMessageId: "user", partIndex: 1, source: "automatic" };
      repo.add({ eventId: "current", sequence: 2, sessionId: session.id, runId: run.id, type: "context.compacted", timestamp: 2, payload });
      expect(repo.listCompactions(session.id)[0]?.partIndex).toBe(1);
      expect(history).not.toHaveBeenCalled();
      repo.add({ eventId: "legacy", sequence: 3, sessionId: session.id, runId: run.id, type: "context.compacted", timestamp: 3, payload: { ...payload, id: "legacy", partIndex: undefined } });
      repo.add({ eventId: "legacy-2", sequence: 4, sessionId: session.id, runId: run.id, type: "context.compacted", timestamp: 4, payload: { ...payload, id: "legacy-2", partIndex: undefined } });
      expect(repo.listCompactions(session.id).map((marker) => marker.partIndex)).toEqual([1, 1, 1]);
      expect(history).toHaveBeenCalledTimes(1);
    } finally { history.mockRestore(); db.$client.close(); }
  });
  test("loads completed and interrupted context markers for the requested session", () => {
    const db = openDb(":memory:");
    const sessions = new SessionRepo(db);
    const first = sessions.create("first");
    const second = sessions.create("second");
    const repo = new EventRepo(db);
    const marker = { id: "request-1", throughMessageId: "message-1", createdAt: 123, status: "completed" as const, source: "manual" as const };
    repo.add({ eventId: "event-1", sequence: 1, sessionId: first.id, type: "context.compacted", timestamp: marker.createdAt, payload: marker });
    repo.add({ eventId: "event-2", sequence: 2, sessionId: first.id, type: "agent.completed", timestamp: 124, payload: {} });
    repo.add({ eventId: "event-3", sequence: 3, sessionId: second.id, type: "context.compacted", timestamp: 125, payload: { id: "other", throughMessageId: "message-2" } });
    repo.add({ eventId: "event-4", sequence: 4, sessionId: first.id, type: "context.compaction.interrupted", timestamp: 126, payload: { id: "request-2", throughMessageId: "message-1" } });
    repo.add({ eventId: "event-5", sequence: 5, sessionId: first.id, type: "context.compacted", timestamp: 127, payload: { id: "automatic", throughMessageId: "message-1", source: "automatic" } });

    expect(repo.listCompactions(first.id)).toEqual([marker, { id: "request-2", throughMessageId: "message-1", createdAt: 126, status: "interrupted", source: "manual" }, { id: "automatic", throughMessageId: "message-1", createdAt: 127, status: "completed", source: "automatic" }]);
    expect(repo.listCompactions(second.id)).toEqual([{ id: "other", throughMessageId: "message-2", createdAt: 125, status: "completed", source: "manual" }]);
    db.$client.close();
  });

  test("restores events and continues sequence after reopening SQLite", () => {
    const path = `${process.env.TEMP ?? process.cwd()}\\qone-event-${crypto.randomUUID()}.db`;
    const firstDb = openDb(path);
    const session = new SessionRepo(firstDb).create("event test");
    const repo = new EventRepo(firstDb);
    const journal = new SequencedEventJournal(0);
    const first = journal.record((sequence) => ({ eventId: "e1", sequence, sessionId: session.id, type: "one", timestamp: Date.now(), payload: { ok: 1 } }));
    repo.add(first);
    firstDb.$client.close();

    const secondDb = openDb(path);
    const restored = new EventRepo(secondDb).list();
    const next = new SequencedEventJournal(restored.at(-1)?.sequence ?? -1 + 1);
    next.restore(restored);
    const second = next.record((sequence) => ({ eventId: "e2", sequence, sessionId: session.id, type: "two", timestamp: Date.now(), payload: { ok: 2 } }));
    expect(restored[0]?.eventId).toBe("e1");
    expect(second.sequence).toBe(first.sequence + 1);
    secondDb.$client.close();
  });
});
