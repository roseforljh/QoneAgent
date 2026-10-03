import { expect, test } from "bun:test";
import { buildSubagentNotificationPrompt, SubagentNotificationCoordinator } from "../src/subagent-notifications";
import type { SubagentNotificationInfo } from "@qone/protocol";

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fixture(running = true) {
  const notices = new Map<string, SubagentNotificationInfo>();
  const child = { runId: "child", parentSessionId: "session", title: "检查配置", task: "task" };
  const noticeRepo = {
    enqueue(input: Omit<SubagentNotificationInfo, "id" | "status" | "createdAt" | "deliveredAt" | "acknowledgedAt">) {
      const id = `${input.subagentRunId}:${input.version}`;
      const existing = notices.get(id);
      if (existing) return existing;
      const created: SubagentNotificationInfo = { ...input, id, status: "pending", createdAt: Date.now() };
      notices.set(id, created);
      return created;
    },
    listBySession(sessionId: string, statuses: SubagentNotificationInfo["status"][] = ["pending", "delivered"]) {
      return [...notices.values()].filter((notice) => notice.sessionId === sessionId && statuses.includes(notice.status));
    },
    listPending(sessionId: string) { return this.listBySession(sessionId, ["pending"]); },
    listUnacknowledged(sessionId: string) { return this.listBySession(sessionId); },
    markDelivered(ids: string[]) { for (const id of ids) { const notice = notices.get(id); if (notice) { notice.status = "delivered"; notice.deliveredAt = Date.now(); } } },
    markPending(ids: string[]) { for (const id of ids) { const notice = notices.get(id); if (notice) { notice.status = "pending"; delete notice.deliveredAt; } } },
    acknowledgeByRunId(runId: string) {
      const sessions = [...notices.values()].filter((notice) => notice.subagentRunId === runId && notice.status !== "acknowledged").map((notice) => notice.sessionId);
      for (const notice of notices.values()) if (notice.subagentRunId === runId) { notice.status = "acknowledged"; notice.acknowledgedAt = Date.now(); }
      return [...new Set(sessions)];
    },
  };
  const runRepo = { get: () => ({ status: running ? "running" : "completed" }) };
  const childRepo = { listBySession: () => running ? [child] : [] };
  const sent: string[] = [];
  const adapter = {
    isRunning: () => running,
    activeRunId: () => running ? "parent" : undefined,
    queueFollowUpNow: (_sessionId: string, prompt: string) => { sent.push(prompt); return running; },
    sendToSession: async (_sessionId: string, prompt: string) => { sent.push(prompt); return running; },
  };
  const published: string[] = [];
  const coordinator = new SubagentNotificationCoordinator(
    noticeRepo as never, childRepo as never, runRepo as never, adapter as never, (sessionId) => published.push(sessionId),
  );
  return { coordinator, notices, sent, published };
}

test("completion is persisted and delivered through a live parent follow-up", async () => {
  const f = fixture(true);
  f.coordinator.enqueue({ sessionId: "session", subagentRunId: "child", version: 1, kind: "completed", title: "检查配置", content: "已完成" });
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toContain("child");
  expect(f.notices.get("child:1")?.status).toBe("delivered");
});

test("a live completion enters Pi's queue before the next microtask", () => {
  const f = fixture(true);
  f.coordinator.enqueue({ sessionId: "session", subagentRunId: "child", version: 1, kind: "completed", title: "检查配置" });
  expect(f.sent).toHaveLength(1);
  expect(f.notices.get("child:1")?.status).toBe("delivered");
});

test("compaction ledger delivery also enters Pi's queue synchronously", () => {
  const f = fixture(true);
  f.coordinator.scheduleLedger("session");
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0]).toContain("当前会话的子代理账本");
});

test("an idle parent keeps the notification pending for the next model run", async () => {
  const f = fixture(false);
  f.coordinator.enqueue({ sessionId: "session", subagentRunId: "child", version: 1, kind: "completed", title: "检查配置" });
  await tick();
  expect(f.sent).toEqual([]);
  expect(f.notices.get("child:1")?.status).toBe("pending");
});

test("the persistent ledger includes running children and unacknowledged completions", () => {
  const f = fixture(true);
  f.coordinator.enqueue({ sessionId: "session", subagentRunId: "child", version: 1, kind: "completed", title: "检查配置" });
  const prompt = f.coordinator.pendingPrompt("session").prompt!;
  expect(prompt).toContain("当前会话的子代理账本");
  expect(prompt).toContain("仍在运行");
  expect(f.coordinator.ledgerPrompt("session")).toContain("已结束但尚未查看");
});

test("notification prompt remains compact and does not include a full child transcript", () => {
  const notification: SubagentNotificationInfo = {
    id: "child:1", sessionId: "session", subagentRunId: "child", version: 1,
    kind: "completed", status: "pending", title: "worker", summaryPreview: "结论摘要", createdAt: 1,
  };
  const prompt = buildSubagentNotificationPrompt([notification]);
  expect(prompt).toContain("结论摘要");
  expect(prompt).not.toContain("message");
});

test("interrupted notifications preserve the restart reason", () => {
  const notification: SubagentNotificationInfo = {
    id: "child:2", sessionId: "session", subagentRunId: "child", version: 2,
    kind: "interrupted", status: "pending", title: "worker", summaryPreview: "该子代理因运行时重启而中断", createdAt: 1,
  };
  expect(buildSubagentNotificationPrompt([notification])).toContain("已中断");
  expect(buildSubagentNotificationPrompt([notification])).toContain("运行时重启");
});
