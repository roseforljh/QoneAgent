import { describe, expect, test } from "bun:test";
import { closeDb, EventRepo, MessageRepo, openDb, RunRepo, SessionRepo, ToolCallRepo, TurnRepo } from "@qone/database";

describe("editing and retrying a user turn", () => {
  test("removes that turn and later model context, runs, tools, and replay events", () => {
    const db = openDb(":memory:");
    try {
      const session = new SessionRepo(db).create();
      const messages = new MessageRepo(db);
      const runs = new RunRepo(db);
      const tools = new ToolCallRepo(db);
      const turns = new TurnRepo(db);
      const events = new EventRepo(db);
      const firstRun = runs.create(session.id);
      const firstUser = messages.add(session.id, "user", "first", firstRun.id);
      messages.addAssistant(session.id, "first answer", firstRun.id);
      const firstEvent = { eventId: crypto.randomUUID(), sessionId: session.id, runId: firstRun.id, sequence: 0, type: "agent.completed", timestamp: Date.now(), payload: {} };
      events.add(firstEvent);
      const secondRun = runs.create(session.id);
      const secondUser = messages.add(session.id, "user", "second", secondRun.id);
      messages.addAssistant(session.id, "old answer", secondRun.id);
      turns.create(secondRun.id);
      tools.start(secondRun.id, "read_file");
      events.add({ eventId: crypto.randomUUID(), sessionId: session.id, runId: secondRun.id, sequence: 1, type: "agent.completed", timestamp: Date.now(), payload: {} });
      const thirdRun = runs.create(session.id);
      messages.add(session.id, "user", "third", thirdRun.id);
      messages.addAssistant(session.id, "third answer", thirdRun.id);
      events.add({ eventId: crypto.randomUUID(), sessionId: session.id, runId: thirdRun.id, sequence: 2, type: "agent.completed", timestamp: Date.now(), payload: {} });

      expect(messages.truncateFrom(session.id, secondUser.id)).toEqual([secondRun.id, thirdRun.id]);
      expect(messages.listBySession(session.id).map((message) => message.content)).toEqual(["first", "first answer"]);
      expect(runs.listBySession(session.id).map((run) => run.id)).toEqual([firstRun.id]);
      expect(tools.listBySession(session.id)).toEqual([]);
      expect(turns.listByRun(secondRun.id)).toEqual([]);
      expect(events.list().map((event) => event.eventId)).toEqual([firstEvent.eventId]);
      expect(() => messages.truncateFrom(session.id, secondUser.id)).toThrow();
      expect(messages.listBySession(session.id)[0]?.id).toBe(firstUser.id);
    } finally {
      closeDb(db);
    }
  });
});
