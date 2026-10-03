import { describe, expect, test } from "bun:test";
import { SequencedEventJournal } from "@qone/shared";

describe("event ordering and reconnect replay", () => {
  test("transient tokens advance the cursor without evicting durable lifecycle events", () => {
    const journal = new SequencedEventJournal<{ sequence: number; sessionId: string; value: string }>(0, 3);
    const started = journal.record((sequence) => ({ sequence, sessionId: "a", value: "started" }));
    for (let index = 0; index < 10000; index++) {
      const delta = journal.record((sequence) => ({ sequence, sessionId: index % 2 ? "a" : "b", value: "delta" }), false);
      expect(delta.sequence).toBe(index + 1);
    }
    const completed = journal.record((sequence) => ({ sequence, sessionId: "a", value: "completed" }));
    expect(completed.sequence).toBe(10001);
    expect(journal.replay()).toEqual([started, completed]);
    expect(journal.replay(5000, "a")).toEqual([completed]);
    expect(journal.next).toBe(10002);
  });
  test("keeps monotonic sequence across a restored seed and filters replay", () => {
    const journal = new SequencedEventJournal<{ sequence: number; sessionId?: string; value: string }>(40, 3);
    journal.record((sequence) => ({ sequence, sessionId: "a", value: "one" }));
    journal.record((sequence) => ({ sequence, sessionId: "b", value: "two" }));
    journal.record((sequence) => ({ sequence, sessionId: "a", value: "three" }));
    journal.record((sequence) => ({ sequence, sessionId: "a", value: "four" }));
    expect(journal.next).toBe(44);
    expect(journal.replay(40).map((event) => event.sequence)).toEqual([41, 42, 43]);
    expect(journal.replay(40, "a").map((event) => event.value)).toEqual(["three", "four"]);
  });

  test("wraps repeatedly, restores unsorted history, and preserves session filtering", () => {
    const journal = new SequencedEventJournal<{ sequence: number; sessionId: string }>(0, 5);
    journal.restore([{ sequence: 9, sessionId: "a" }, { sequence: 2, sessionId: "b" }, { sequence: 7, sessionId: "b" }]);
    const reference = journal.replay();
    for (let i = 0; i < 40; i++) {
      const event = journal.record((sequence) => ({ sequence, sessionId: i % 2 ? "b" : "a" }));
      reference.push(event);
      if (reference.length > 5) reference.shift();
      expect(journal.replay()).toEqual(reference);
      expect(journal.replay(event.sequence - 3, "a")).toEqual(reference.filter((item) => item.sequence > event.sequence - 3 && item.sessionId === "a"));
    }
    journal.restore([{ sequence: 80, sessionId: "a" }, { sequence: 70, sessionId: "b" }]);
    expect(journal.record((sequence) => ({ sequence, sessionId: "b" })).sequence).toBe(81);
    expect(journal.replay().map((event) => event.sequence)).toEqual([70, 80, 81]);
  });

  test("zero capacity retains sequence continuity without storing payloads", () => {
    const journal = new SequencedEventJournal(10, 0);
    journal.restore([{ sequence: 20 }]);
    expect(journal.record((sequence) => ({ sequence })).sequence).toBe(21);
    expect(journal.replay()).toEqual([]);
    expect(() => new SequencedEventJournal(0, -1)).toThrow(RangeError);
  });
});
