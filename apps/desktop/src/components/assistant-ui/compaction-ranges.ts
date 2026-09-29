import type { AssistantPartRange } from "./assistant-part-ranges";

export interface PositionedCompaction {
  id: string;
  partIndex: number;
  startedAt: number;
  status: "running" | "completed" | "interrupted";
  source: "manual" | "automatic";
}

/** Persisted boundaries count non-reasoning parts regardless of display policy. */
export function compactionDisplayIndex(parts: readonly { type: string }[], partIndex: number): number {
  if (partIndex === 0) return 0;
  let count = 0;
  for (let index = 0; index < parts.length; index++) {
    if (parts[index]?.type !== "reasoning" && ++count === partIndex) return index + 1;
  }
  return parts.length;
}

/** Split grouped tools/images at actual event boundaries, preserving part indices. */
export function compactionRangeSegments(ranges: readonly AssistantPartRange[], markers: readonly PositionedCompaction[]) {
  let remaining = [...ranges];
  const segments: { ranges: AssistantPartRange[]; marker?: PositionedCompaction }[] = [];
  for (const marker of [...markers].sort((a, b) => a.partIndex - b.partIndex || a.startedAt - b.startedAt)) {
    const before: AssistantPartRange[] = [];
    const after: AssistantPartRange[] = [];
    for (const range of remaining) {
      if ("index" in range) {
        (range.index < marker.partIndex ? before : after).push(range);
      } else if (range.endIndex <= marker.partIndex) before.push(range);
      else if (range.startIndex >= marker.partIndex) after.push(range);
      else {
        before.push({ ...range, endIndex: marker.partIndex });
        after.push({ ...range, startIndex: marker.partIndex });
      }
    }
    segments.push({ ranges: before, marker });
    remaining = after;
  }
  segments.push({ ranges: remaining });
  return segments;
}
