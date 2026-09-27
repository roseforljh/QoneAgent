import { describe, expect, test } from "bun:test";
import { openDb, GoalRepo, SessionRepo } from "@qone/database";

describe("goal persistence", () => {
  test("stores lifecycle state and rejects stale goal identity at the repository boundary", () => {
    const db = openDb(":memory:");
    try {
      const sessions = new SessionRepo(db);
      const session = sessions.create("Goal test", "workspace");
      const goals = new GoalRepo(db);
      const goal = goals.create(session.id, "Make the test pass", { model: "openai/gpt-test", permissionMode: "auto", thinking: "high" });

      expect(goals.getBySession(session.id)).toMatchObject({ id: goal.id, status: "active", epoch: 1 });
      expect(goals.getOptions(goal.id)).toEqual({ model: "openai/gpt-test", permissionMode: "auto", thinking: "high" });
      const paused = goals.update(goal.id, { status: "paused", stopReason: "user pause", bumpEpoch: true });
      expect(paused).toMatchObject({ status: "paused", stopReason: "user pause", epoch: 2 });
      const resumed = goals.update(goal.id, { status: "active", stopReason: null, bumpEpoch: true });
      expect(resumed).toMatchObject({ status: "active", epoch: 3 });

      goals.event(goal.id, session.id, "resumed", { epoch: resumed.epoch });
      goals.deleteForSession(session.id);
      expect(goals.getBySession(session.id)).toBeUndefined();
    } finally {
      db.$client.close();
    }
  });
});
