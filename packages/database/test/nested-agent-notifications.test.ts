import { expect, test } from "bun:test";
import { closeDb, openDb, RunRepo, SessionRepo, SubagentNotificationRepo, SubagentRunRepo } from "../src";

test("nested notifications keep the conversation foreign key but address only the direct parent", () => {
  const db = openDb(":memory:");
  try {
    const sessions = new SessionRepo(db), runs = new RunRepo(db), children = new SubagentRunRepo(db);
    const notices = new SubagentNotificationRepo(db);
    const root = sessions.create("root"), other = sessions.create("other"), parent = runs.create(root.id);
    const outer = runs.create(root.id), leaf = runs.create(root.id);
    children.create({ runId: outer.id, parentSessionId: root.id, parentRunId: parent.id,
      executionSessionId: "outer-execution", toolCallId: "outer", title: "Outer", task: "outer" });
    children.create({ runId: leaf.id, parentSessionId: root.id, parentRunId: outer.id, parentSubagentId: outer.id,
      executionSessionId: "leaf-execution", toolCallId: "leaf", title: "Leaf", task: "leaf" });
    const direct = notices.enqueue({ sessionId: root.id, subagentRunId: outer.id, version: 1, kind: "completed", title: "Outer" });
    const nested = notices.enqueue({ sessionId: "outer-execution", subagentRunId: leaf.id, version: 1, kind: "completed", title: "Leaf" });
    expect(nested.sessionId).toBe("outer-execution");
    expect(notices.listPending(root.id).map(notice => notice.id)).toEqual([direct.id]);
    expect(notices.listPending("outer-execution").map(notice => notice.id)).toEqual([nested.id]);
    expect(notices.listPending(other.id)).toEqual([]);
    expect(notices.acknowledgeByRunId(leaf.id)).toEqual(["outer-execution"]);
    expect(notices.listPending("outer-execution")).toEqual([]);
    sessions.delete(root.id);
    expect(notices.listPending(root.id)).toEqual([]);
    expect(notices.listPending("outer-execution")).toEqual([]);
  } finally { closeDb(db); }
});
