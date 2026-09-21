import { describe, expect, test } from "bun:test";
import { EventRepo, SessionRepo, openDb } from "@qone/database";
import { SequencedEventJournal } from "@qone/shared";

describe("persistent event journal", () => {
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
