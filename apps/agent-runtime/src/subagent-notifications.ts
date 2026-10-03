import type { SubagentNotificationInfo } from "@qone/protocol";
import type { RunRepo, SubagentNotificationRepo, SubagentRunRepo } from "@qone/database";
import type { PiAdapter } from "./pi-adapter.js";

/** Marker kept in the prompt so the runtime can distinguish an internal
 * follow-up from a user steer when Pi emits the queued user message event. */
export const SUBAGENT_NOTIFICATION_MARKER = "[QONE_SUBAGENT_NOTIFICATION]";
export const SUBAGENT_LEDGER_MARKER = "[QONE_SUBAGENT_LEDGER]";

const MAX_PREVIEW_LENGTH = 180;
// A timer is only a retry path. The first live delivery is synchronous so a
// parent can still be finishing a turn or processing compaction_end.
const DELIVERY_RETRY_DELAY_MS = 120;

const activeStatuses = new Set(["created", "running", "waiting_approval", "paused"]);

type NotificationSource = {
  sessionId: string;
  subagentRunId: string;
  version: number;
  kind: SubagentNotificationInfo["kind"];
  title: string;
  content?: string;
};

type Delivery = { prompt?: string; ids: string[] };

function preview(content: string | undefined): string | undefined {
  const value = content?.replace(/\s+/g, " ").trim();
  if (!value) return undefined;
  return value.length > MAX_PREVIEW_LENGTH ? `${value.slice(0, MAX_PREVIEW_LENGTH - 1)}…` : value;
}

export function buildSubagentNotificationPrompt(notifications: readonly SubagentNotificationInfo[], ledger?: string): string {
  const lines = notifications.map((notice) => {
    const result = notificationResult(notice.kind);
    const detail = notice.summaryPreview ? ` 摘要：${notice.summaryPreview}` : "";
    return `- 「${notice.title}」${result}，runId=${notice.subagentRunId}.${detail}`;
  });
  return [
    SUBAGENT_NOTIFICATION_MARKER,
    "后台子代理状态更新：",
    ...lines,
    ledger,
    "这些通知只用于保持状态感知；不需要现在读取完整结果。需要时调用 inspect_subagent(runId)，也可以先继续当前工作。",
  ].filter(Boolean).join("\n");
}

export function isSubagentNotificationPrompt(value: unknown): boolean {
  return typeof value === "string" && value.includes(SUBAGENT_NOTIFICATION_MARKER);
}

function notificationResult(kind: SubagentNotificationInfo["kind"]): string {
  return kind === "completed" ? "已完成" : kind === "failed" ? "失败" : kind === "interrupted" ? "已中断" : "已取消";
}

/**
 * Coordinates durable child completion notices with Pi's live follow-up queue.
 * The queue is intentionally outside the model transcript: a failed or late
 * delivery remains pending and can be recovered on the next user turn.
 */
export class SubagentNotificationCoordinator {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly inFlight = new Set<string>();
  private readonly ledgerRequested = new Set<string>();

  constructor(
    private readonly repo: SubagentNotificationRepo,
    private readonly subagentRuns: SubagentRunRepo,
    private readonly runs: RunRepo,
    private readonly adapter: PiAdapter,
    private readonly publish: (sessionId: string) => void,
  ) {}

  enqueue(source: NotificationSource): SubagentNotificationInfo {
    const notice = this.repo.enqueue({
      sessionId: source.sessionId,
      subagentRunId: source.subagentRunId,
      version: source.version,
      kind: source.kind,
      title: source.title,
      summaryPreview: preview(source.content),
    });
    this.publish(source.sessionId);
    // Do not defer the first live delivery. A fixed debounce can run after
    // the parent has already ended, and after Pi has checked its continuation
    // queue at compaction_end.
    if (this.adapter.isRunning(source.sessionId)) void this.flush(source.sessionId);
    return notice;
  }

  acknowledge(runId: string): void {
    // The repository owns the update; publishing is best-effort and the next
    // session snapshot will also converge if the UI was disconnected.
    for (const sessionId of this.repo.acknowledgeByRunId(runId)) this.publish(sessionId);
  }

  pendingPrompt(sessionId: string): Delivery {
    const pending = this.repo.listPending(sessionId);
    const ledger = this.ledgerPrompt(sessionId, false);
    if (!pending.length) return { prompt: this.ledgerPrompt(sessionId), ids: [] };
    return { prompt: buildSubagentNotificationPrompt(pending, ledger), ids: pending.map((notice) => notice.id) };
  }

  markDelivered(ids: string[]): void {
    this.repo.markDelivered(ids);
  }

  markPending(ids: string[]): void {
    this.repo.markPending(ids);
  }

  snapshot(sessionId: string): SubagentNotificationInfo[] {
    return this.repo.listBySession(sessionId);
  }

  /** Build a small durable ledger that can be reintroduced after compaction or restart. */
  ledgerPrompt(sessionId: string, includeNotices = true): string | undefined {
    // Root sessions own direct children by parentSessionId. A nested child
    // runs in its own execution session, so resolve its direct children by
    // parentRunId or compaction would make the nested ledger disappear.
    const getOwner = (this.subagentRuns as unknown as {
      getByExecutionSession?: (id: string) => { runId: string } | undefined;
    }).getByExecutionSession;
    const listByParentRunId = (this.subagentRuns as unknown as {
      listByParentRunId?: (runId: string) => ReturnType<SubagentRunRepo["listBySession"]>;
    }).listByParentRunId;
    const owner = getOwner?.call(this.subagentRuns, sessionId);
    const rows = owner && listByParentRunId
      ? listByParentRunId.call(this.subagentRuns, owner.runId)
      : this.subagentRuns.listBySession(sessionId);
    const running = rows.filter((row) => activeStatuses.has(this.runs.get(row.runId)?.status ?? ""));
    const notices = includeNotices ? this.repo.listUnacknowledged(sessionId) : [];
    if (!running.length && !notices.length) return undefined;
    const lines = [SUBAGENT_LEDGER_MARKER, "当前会话的子代理账本："];
    if (running.length) {
      lines.push("仍在运行：");
      for (const row of running) lines.push(`- 「${row.title}」runId=${row.runId}`);
    }
    if (notices.length) {
      lines.push("已结束但尚未查看：");
      for (const notice of notices) {
        const result = notificationResult(notice.kind);
        lines.push(`- 「${notice.title}」${result}，runId=${notice.subagentRunId}`);
      }
    }
    lines.push("这是持久状态摘要，不要求立即处理；需要时调用 list_subagents 或 inspect_subagent。");
    return lines.join("\n");
  }

  schedule(sessionId: string): void {
    if (!this.adapter.isRunning(sessionId)) return;
    if (this.timers.has(sessionId) || this.inFlight.has(sessionId)) return;
    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      void this.flush(sessionId);
    }, DELIVERY_RETRY_DELAY_MS);
    this.timers.set(sessionId, timer);
  }

  scheduleLedger(sessionId: string): void {
    this.ledgerRequested.add(sessionId);
    if (this.adapter.isRunning(sessionId)) void this.flush(sessionId);
  }

  async flush(sessionId: string): Promise<boolean> {
    if (this.inFlight.has(sessionId)) return false;
    const delivery = this.pendingPrompt(sessionId);
    const ledgerOnly = !delivery.prompt && this.ledgerRequested.has(sessionId);
    const prompt = delivery.prompt ?? (ledgerOnly ? this.ledgerPrompt(sessionId) : undefined);
    if (!prompt || !this.adapter.isRunning(sessionId)) return false;
    const activeRunId = this.adapter.activeRunId(sessionId);
    if (!activeRunId) return false;

    this.inFlight.add(sessionId);
    try {
      // This path must remain synchronous through the actual Pi queue write.
      // Fall back to the general adapter method only for older test doubles or
      // adapters; the production PiAdapter exposes the sync queue entrypoint.
      const accepted = this.adapter.queueFollowUpNow
        ? this.adapter.queueFollowUpNow(sessionId, prompt, activeRunId)
        : await this.adapter.sendToSession(sessionId, prompt, "follow_up", undefined, activeRunId);
      if (!accepted) return false;
      this.markDelivered(delivery.ids);
      this.ledgerRequested.delete(sessionId);
      this.publish(sessionId);
      return true;
    } finally {
      this.inFlight.delete(sessionId);
      if ((this.repo.listPending(sessionId).length || this.ledgerRequested.has(sessionId)) && this.adapter.isRunning(sessionId)) this.schedule(sessionId);
    }
  }
}
