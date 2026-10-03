import type { PartState } from "@assistant-ui/react";
import { textPhaseFromParentId, type DisplayTextPhase } from "../../lib/assistant-message-parts";
import { toolActivityCategory } from "./tool-activity-category";
import type { PositionedCompaction } from "./compaction-ranges";

export type AssistantPartRange =
  | { type: "text"; index: number; phase?: DisplayTextPhase }
  | { type: "reasoning"; index: number }
  | { type: "image"; index: number }
  | { type: "images"; startIndex: number; endIndex: number }
  | { type: "compaction"; index: number; marker: PositionedCompaction }
  | { type: "tools"; startIndex: number; endIndex: number }
  | { type: "presentation"; index: number };

export interface AssistantRangeSections {
  leading: AssistantPartRange[];
  process: AssistantPartRange[];
  activity: AssistantPartRange[];
  persistent: AssistantPartRange[];
  answer: AssistantPartRange[];
}

function toolGroupKind(name: string): "exploration" | "action" {
  return toolActivityCategory(name) === "exploration" ? "exploration" : "action";
}

/** Keep final answer content outside the execution disclosure. */
export function assistantRangeSections(ranges: readonly AssistantPartRange[]): AssistantRangeSections {
  let lastActivityIndex = -1;
  let lastContentIndex = -1;
  for (let index = ranges.length - 1; index >= 0; index--) {
    const type = ranges[index]?.type;
    if (type === "text" || type === "image" || type === "images" || type === "presentation") {
      lastContentIndex = index;
      break;
    }
  }
  for (let index = ranges.length - 1; index >= 0; index--) {
    const type = ranges[index]?.type;
    if (type === "tools" || type === "reasoning"
      || (type === "compaction" && (index < lastContentIndex || lastContentIndex < 0))) {
      lastActivityIndex = index;
      break;
    }
  }
  const finalIndex = ranges.findIndex((range) => range.type === "text" && range.phase === "final_answer");
  const hasPhasedText = ranges.some((range) => range.type === "text" && range.phase !== undefined);
  const answerIndex = finalIndex >= 0 ? finalIndex : hasPhasedText ? ranges.length : lastActivityIndex + 1;
  const firstActivityIndex = ranges.findIndex((range, index) => index < answerIndex && (range.type === "text" || range.type === "tools" || range.type === "reasoning" || range.type === "compaction"));
  if (firstActivityIndex < 0) return { leading: ranges.slice(0, answerIndex), process: [], activity: [], persistent: [], answer: ranges.slice(answerIndex) };

  const leading = ranges.slice(0, firstActivityIndex);
  const process = ranges.slice(firstActivityIndex, answerIndex);
  const activity: AssistantPartRange[] = [];
  const persistent: AssistantPartRange[] = [];
  for (const range of process) {
    if (range.type === "text" || range.type === "tools" || range.type === "reasoning" || range.type === "compaction") activity.push(range);
    else persistent.push(range);
  }
  return { leading, process, activity, persistent, answer: ranges.slice(answerIndex) };
}

export function executionDisplayBlocks(process: readonly AssistantPartRange[]) {
  const blocks: { kind: "activity" | "persistent"; ranges: AssistantPartRange[] }[] = [];
  for (const range of process) {
    const kind = range.type === "image" || range.type === "images" || range.type === "presentation" ? "persistent" : "activity";
    const last = blocks.at(-1);
    if (last?.kind === kind) last.ranges.push(range);
    else blocks.push({ kind, ranges: [range] });
  }
  return blocks;
}

export function hasVisibleAnswer(parts: readonly PartState[], ranges: readonly AssistantPartRange[]): boolean {
  return ranges.some((range) => {
    if (range.type === "text") {
      const part = parts[range.index];
      return part?.type === "text" && part.text.trim().length > 0;
    }
    return range.type === "image" || range.type === "images" || range.type === "presentation";
  });
}

function isPresentation(part: PartState): boolean {
  return part.type === "tool-call" && part.toolName === "present" && !part.isError;
}

function parentId(part: PartState): string | undefined {
  return (part as PartState & { parentId?: string }).parentId;
}

export function assistantPartRanges(parts: readonly PartState[]): AssistantPartRange[] {
  const ranges: AssistantPartRange[] = [];
  for (let index = 0; index < parts.length;) {
    const part = parts[index]!;
    if (part.type === "text" || part.type === "reasoning") {
      if (part.type === "reasoning") ranges.push({ type: "reasoning", index });
      else if (part.text.trim()) {
        const phase = textPhaseFromParentId(part.parentId);
        ranges.push({ type: "text", index, ...(phase ? { phase } : {}) });
      }
      index++;
      continue;
    }
    if (part.type === "image") {
      const startIndex = index;
      while (index < parts.length && parts[index]?.type === "image") index++;
      ranges.push(index - startIndex === 1
        ? { type: "image", index: startIndex }
        : { type: "images", startIndex, endIndex: index });
      continue;
    }
    if (isPresentation(part)) {
      ranges.push({ type: "presentation", index });
      index++;
      continue;
    }
    if (part.type === "tool-call") {
      const startIndex = index;
      const firstParentId = parentId(part);
      const firstKind = toolGroupKind(part.toolName);
      index++;
      while (index < parts.length) {
        const next = parts[index]!;
        if (next.type !== "tool-call" || isPresentation(next)) break;
        if (toolGroupKind(next.toolName) !== firstKind) break;
        const nextParentId = parentId(next);
        if (firstParentId !== undefined && nextParentId !== undefined && nextParentId !== firstParentId) break;
        index++;
      }
      ranges.push({ type: "tools", startIndex, endIndex: index });
      continue;
    }
    index++;
  }
  return ranges;
}
