import { getLatestCompactionEntry, type AgentSession, type CompactionEntry } from "@earendil-works/pi-coding-agent";
import type { PersistedPiMessage } from "./pi-attachments.js";

export interface SessionCompactionCheckpoint {
  throughMessageId: string;
  context: unknown[];
  assistantPrefix?: { runId: string; count: number };
}

export function captureCompactedContext(session: AgentSession): unknown[] {
  const entry = getLatestCompactionEntry(session.sessionManager.getBranch());
  return session.messages.map((message) => message.role === "compactionSummary"
    ? { ...message, details: entry?.details } : message);
}

/** The DB already has the new user row when Pi compacts before accepting its prompt. */
export function automaticCompactionBoundary(
  history: readonly { id: string; role: string; runId?: string | null; communication?: unknown; rawMessage?: unknown }[],
  runId: string,
  initialUserSeen: boolean,
  pendingAssistantCount: number,
): Omit<SessionCompactionCheckpoint, "context"> | undefined {
  // A runtime-started turn's prompt is a communication row that carries its native message.
  const pendingUser = initialUserSeen ? -1 : history.findIndex((row) => row.runId === runId && row.role === "user" && (!row.communication || Boolean(row.rawMessage)));
  const anchor = history[pendingUser < 0 ? history.length - 1 : pendingUser - 1];
  return anchor && {
    throughMessageId: anchor.id,
    ...(pendingAssistantCount > 0 && { assistantPrefix: { runId, count: pendingAssistantCount } }),
  };
}

/** Keep visible SQLite history intact while restoring only Pi's compacted context. */
export function restoreCompactedContext<T extends PersistedPiMessage & { id: string; runId?: string | null; communication?: unknown }>(
  history: T[],
  checkpoint?: SessionCompactionCheckpoint,
): PersistedPiMessage[] {
  // Communication rows without a native message are UI-only. They may still
  // anchor a checkpoint, including one saved by an older manual compaction.
  const replayable = (message: T) => !message.communication || Boolean(message.rawMessage);
  if (!checkpoint || !Array.isArray(checkpoint.context)) return history.filter(replayable);
  const boundary = history.findIndex((message) => message.id === checkpoint.throughMessageId);
  if (boundary < 0) return history.filter(replayable);
  const compacted: PersistedPiMessage[] = [];
  let summary: (Pick<CompactionEntry, "summary" | "tokensBefore" | "details"> & { timestamp?: number }) | undefined;
  let systemMessage: CompactionEntry["systemMessage"];
  for (const rawMessage of checkpoint.context) {
    if (!rawMessage || typeof rawMessage !== "object" || !("role" in rawMessage) || typeof rawMessage.role !== "string") continue;
    const message = rawMessage as { role: string; timestamp?: number };
    if (message.role === "compactionSummary") {
      const value = rawMessage as typeof message & NonNullable<typeof summary>;
      if (typeof value.summary === "string" && typeof value.tokensBefore === "number") summary = value;
    } else if (message.role === "system" && !summary) {
      systemMessage = rawMessage as CompactionEntry["systemMessage"];
    } else {
      compacted.push({ role: message.role, content: "", createdAt: message.timestamp ?? Date.now(), rawMessage });
    }
  }
  if (!summary) return history.filter(replayable);
  // Pi's native boundary belongs *after* the retained tail. Pi projects the
  // summary before it, but won't reuse pre-compaction provider usage from it.
  compacted.push({ role: "compactionSummary", content: "", createdAt: summary.timestamp ?? Date.now(),
    compaction: { summary: summary.summary, tokensBefore: summary.tokensBefore, details: summary.details, systemMessage } });
  const newer = history.slice(boundary + 1).filter(replayable);
  const prefix = checkpoint.assistantPrefix;
  if (prefix) {
    // The active assistant segment is saved later as one SQLite row. A steer
    // ends that segment; never trim a reply belonging to the next segment.
    const index = newer.findIndex((message) => message.runId === prefix.runId && !message.communication);
    const row = newer[index];
    if (row?.role === "assistant" && Array.isArray(row.rawMessage) && row.rawMessage.length >= prefix.count) {
      const rawMessage = row.rawMessage.slice(prefix.count);
      newer.splice(index, 1, ...(rawMessage.length ? [{ ...row, rawMessage }] : []));
    }
  }
  return [...compacted, ...newer];
}
