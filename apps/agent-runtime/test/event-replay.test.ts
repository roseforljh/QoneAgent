import { describe, expect, test } from "bun:test";
import { SequencedEventJournal } from "@qone/shared";

describe("event ordering and reconnect replay", () => {
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
});
