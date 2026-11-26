import type { SubagentNotificationInfo } from "@qone/protocol";
import type { RunRepo, SubagentNotificationRepo, SubagentRunRepo } from "@qone/database";
import type { PiAdapter } from "./pi-adapter.js";
import { extractTextContent } from "./pi-message-utils.js";
import { BACKGROUND_SHELL_MARKER } from "./background-shell.js";
import { runtimeText } from "./runtime-localization.js";

/** Reserved prefixes distinguish internal updates from user steering messages. */
export const SUBAGENT_NOTIFICATION_MARKER = "[QONE_SUBAGENT_NOTIFICATION]";
export const SUBAGENT_LEDGER_MARKER = "[QONE_SUBAGENT_LEDGER]";
/** A child → parent message delivered into the parent's live turn. */
export const SUBAGENT_AGENT_MESSAGE_MARKER = "[QONE_AGENT_MESSAGE]";

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
    const status = notificationResult(notice.kind);
    const detail = notice.summaryPreview ? runtimeText("subagent.notice.summary", { summary: notice.summaryPreview }) : "";
    return runtimeText("subagent.notice.item", { title: notice.title, status, runId: notice.subagentRunId, detail });
  });
  return [
    SUBAGENT_NOTIFICATION_MARKER,
    runtimeText("subagent.notice.header"),
    ...lines,
    ledger,
    runtimeText("subagent.notice.guidance"),
  ].filter(Boolean).join("\n");
}

function hasInternalFlag(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  const record = value as { qoneInternal?: unknown; message?: unknown };
  if (record.qoneInternal === true) return true;
  if (record.message && record.message !== value) return hasInternalFlag(record.message);
  return false;
}

export function isSubagentUpdatePrompt(value: unknown): boolean {
  if (hasInternalFlag(value)) return true;
  // 兼容旧历史记录中未带结构化标记的内部前缀消息
  const text = extractTextContent(value);
  return text.startsWith(SUBAGENT_NOTIFICATION_MARKER) || text.startsWith(SUBAGENT_LEDGER_MARKER)
    || text.startsWith(SUBAGENT_AGENT_MESSAGE_MARKER) || text.startsWith(BACKGROUND_SHELL_MARKER);
}

/** The marker-wrapped text of an internal prompt, used as its delivery key. */
export function subagentUpdateText(value: unknown): string {
  return extractTextContent(value);
}

function notificationResult(kind: SubagentNotificationInfo["kind"]): string {
  return runtimeText(`subagent.status.${kind}`);
}

/**
 * Coordinates durable child completion notices with Pi's next-turn input queue.
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
    const lines = [SUBAGENT_LEDGER_MARKER, runtimeText("subagent.ledger.header")];
    if (running.length) {
      lines.push(runtimeText("subagent.ledger.running"));
      for (const row of running) lines.push(runtimeText("subagent.ledger.itemRunning", { title: row.title, runId: row.runId }));
    }
    if (notices.length) {
      lines.push(runtimeText("subagent.ledger.unacknowledged"));
      for (const notice of notices) {
        const status = notificationResult(notice.kind);
        lines.push(runtimeText("subagent.ledger.itemFinished", { title: notice.title, status, runId: notice.subagentRunId }));
      }
    }
    lines.push(runtimeText("subagent.ledger.footer"));
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

  dispose(sessionId: string): void {
    const timer = this.timers.get(sessionId);
    if (timer) clearTimeout(timer);
    this.timers.delete(sessionId);
    this.ledgerRequested.delete(sessionId);
  }

  scheduleLedger(sessionId: string): void {
    if (!this.ledgerPrompt(sessionId)) return;
    this.ledgerRequested.add(sessionId);
    if (this.adapter.isRunning(sessionId)) void this.flush(sessionId);
  }

  async flush(sessionId: string): Promise<boolean> {
    if (this.inFlight.has(sessionId)) return false;
    const delivery = this.pendingPrompt(sessionId);
    const ledgerOnly = !delivery.prompt && this.ledgerRequested.has(sessionId);
    const prompt = delivery.prompt ?? (ledgerOnly ? this.ledgerPrompt(sessionId) : undefined);
    if (!prompt || !this.adapter.isRunning(sessionId)) { this.dispose(sessionId); return false; }
    const activeRunId = this.adapter.activeRunId(sessionId);
    if (!activeRunId) return false;

    this.inFlight.add(sessionId);
    try {
      // This path must remain synchronous through the actual Pi queue write.
      const accepted = this.adapter.queueSubagentUpdateNow(sessionId, prompt, activeRunId);
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
