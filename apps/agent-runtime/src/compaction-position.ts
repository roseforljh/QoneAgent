import type { AssistantMessagePart } from "@qone/protocol";

/** Reasoning is excluded by the desktop message adapter. */
export function compactionPartIndex(parts: readonly AssistantMessagePart[]): number {
  return parts.filter((part) => part.type !== "reasoning").length;
}

export class CompactionPositions {
  private pending = new Map<string, { id: string; runId: string; partIndex: number; startedAt: number }>();

  update(runId: string, eventId: string, timestamp: number, starting: boolean, parts: readonly AssistantMessagePart[]) {
    const position = (!starting && this.pending.get(runId)) || {
      id: eventId, runId, partIndex: compactionPartIndex(parts), startedAt: timestamp,
    };
    if (starting) this.pending.set(runId, position);
    else this.pending.delete(runId);
    return position;
  }
}
