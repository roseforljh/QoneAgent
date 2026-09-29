import { expect, test } from "bun:test";
import { CompactionPositions } from "../src/compaction-position";
import { EventRepo, MessageRepo, SessionRepo, openDb } from "@qone/database";
import type { AssistantMessagePart } from "@qone/protocol";

const parts: AssistantMessagePart[] = [
  { type: "reasoning", text: "hidden", messageSequence: 1 },
  { type: "text", text: "before", messageSequence: 1 },
  { type: "tool-call", toolCallId: "tool", toolName: "read", args: {}, messageSequence: 2 },
  { type: "text", text: "after", messageSequence: 20 },
];

test("completion updates the original position and each new compaction gets its own identity", () => {
  const positions = new CompactionPositions();
  const start = positions.update("run", "start", 10, true, parts.slice(0, 3));
  expect(start.partIndex).toBe(2);
  expect(positions.update("run", "end", 15, false, parts)).toEqual(start);
  expect(positions.update("run", "next", 30, true, parts)).toEqual({ id: "next", runId: "run", startedAt: 30, partIndex: 3 });
});

test("history restores saved positions and recovers legacy positions from event sequences", () => {
  const db = openDb(":memory:");
  try {
    const session = new SessionRepo(db).create("compaction");
    new MessageRepo(db).addAssistant(session.id, "answer", "run", undefined, parts);
    const events = new EventRepo(db);
    events.add({ eventId: "legacy", sequence: 10, sessionId: session.id, runId: "run", type: "context.compacted", timestamp: 100, payload: { id: "legacy", source: "automatic", throughMessageId: "user" } });
    events.add({ eventId: "saved", sequence: 30, sessionId: session.id, runId: "run", type: "context.compaction.interrupted", timestamp: 200, payload: { id: "saved", source: "automatic", throughMessageId: "user", partIndex: 3 } });
    const restored = events.listCompactions(session.id);
    expect(restored.map(({ id, runId, partIndex, status }) => ({ id, runId, partIndex, status }))).toEqual([
      { id: "legacy", runId: "run", partIndex: 2, status: "completed" },
      { id: "saved", runId: "run", partIndex: 3, status: "interrupted" },
    ]);
  } finally { db.$client.close(); }
});
