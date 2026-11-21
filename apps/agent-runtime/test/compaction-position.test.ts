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
  const start = positions.update("run", "start", 10, true, "initial-user", parts.slice(0, 3));
  expect(start.partIndex).toBe(2);
  expect(positions.update("run", "end", 15, false, "steer", [])).toEqual(start);
  expect(positions.update("run", "next", 30, true, "steer", parts)).toEqual({ id: "next", runId: "run", throughMessageId: "steer", startedAt: 30, partIndex: 3 });
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

test("saved automatic markers use the steer delivered at the start, even at the same timestamp", () => {
  const db = openDb(":memory:");
  try {
    const session = new SessionRepo(db).create("compaction");
    const events = new EventRepo(db);
    const ids = { sessionId: session.id, runId: "run", timestamp: 100 };
    const marker = (id: string) => ({ id, throughMessageId: "initial", partIndex: 1, source: "automatic" });
    events.addMany([
      { ...ids, eventId: "e1", sequence: 1, type: "context.compaction.started", payload: marker("before") },
      { ...ids, eventId: "e2", sequence: 2, type: "agent.steer.delivered", payload: { queueItemId: "steer-1" } },
      { ...ids, eventId: "e3", sequence: 3, type: "context.compacted", payload: marker("before") },
      { ...ids, eventId: "e4", sequence: 4, type: "context.compaction.started", payload: marker("after") },
      { ...ids, eventId: "e5", sequence: 5, type: "agent.steer.delivered", payload: { queueItemId: "steer-2" } },
      { ...ids, eventId: "e6", sequence: 6, type: "context.compacted", payload: marker("after") },
    ]);
    expect(events.listCompactions(session.id).map(({ id, throughMessageId, partIndex }) => [id, throughMessageId, partIndex])).toEqual([
      ["before", "initial", 1], ["after", "steer-1", 1],
    ]);
  } finally { db.$client.close(); }
});
