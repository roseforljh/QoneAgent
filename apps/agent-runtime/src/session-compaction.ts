import type { PersistedPiMessage } from "./pi-adapter.js";

export interface SessionCompactionCheckpoint {
  throughMessageId: string;
  context: unknown[];
}

/** Keep visible SQLite history intact while restoring only Pi's compacted context. */
export function restoreCompactedContext<T extends PersistedPiMessage & { id: string }>(
  history: T[],
  checkpoint?: SessionCompactionCheckpoint,
): PersistedPiMessage[] {
  if (!checkpoint) return history;
  const boundary = history.findIndex((message) => message.id === checkpoint.throughMessageId);
  if (boundary < 0 || !Array.isArray(checkpoint.context)) return history;
  const compacted = checkpoint.context.flatMap((rawMessage) => {
    if (!rawMessage || typeof rawMessage !== "object" || typeof (rawMessage as { role?: unknown }).role !== "string") return [];
    const message = rawMessage as { role: string; timestamp?: number };
    return [{ role: message.role, content: "", createdAt: message.timestamp ?? Date.now(), rawMessage }];
  });
  return [...compacted, ...history.slice(boundary + 1)];
}
