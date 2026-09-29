import type { PartState } from "@assistant-ui/react";

export type AssistantPartRange =
  | { type: "text"; index: number }
  | { type: "reasoning"; index: number }
  | { type: "image"; index: number }
  | { type: "images"; startIndex: number; endIndex: number }
  | { type: "subagents"; index: number }
  | { type: "tools"; startIndex: number; endIndex: number }
  | { type: "presentation"; index: number };

export interface AssistantRangeSections {
  leading: AssistantPartRange[];
  activity: AssistantPartRange[];
  persistent: AssistantPartRange[];
  answer: AssistantPartRange[];
}

/** Keep final answer content outside the execution disclosure. */
export function assistantRangeSections(ranges: readonly AssistantPartRange[]): AssistantRangeSections {
  let lastActivityIndex = -1;
  for (let index = ranges.length - 1; index >= 0; index--) {
    if (ranges[index]?.type === "tools" || ranges[index]?.type === "reasoning") {
      lastActivityIndex = index;
      break;
    }
  }
  if (lastActivityIndex < 0) return { leading: [], activity: [], persistent: [], answer: [...ranges] };

  const firstActivityIndex = ranges.findIndex((range) => range.type === "text" || range.type === "tools" || range.type === "reasoning");
  const leading = ranges.slice(0, firstActivityIndex);
  const activity: AssistantPartRange[] = [];
  const persistent: AssistantPartRange[] = [];
  for (const range of ranges.slice(firstActivityIndex, lastActivityIndex + 1)) {
    if (range.type === "text" || range.type === "tools" || range.type === "reasoning") activity.push(range);
    else persistent.push(range);
  }
  return { leading, activity, persistent, answer: ranges.slice(lastActivityIndex + 1) };
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
      ranges.push({ type: part.type, index });
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
      index++;
      while (index < parts.length) {
        const next = parts[index]!;
        if (next.type !== "tool-call" || isPresentation(next)) break;
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

export function visibleAssistantPartRanges(parts: readonly PartState[], hideSubagentCalls: boolean, showSubagentCapsule: boolean): AssistantPartRange[] {
  const firstDispatchIndex = showSubagentCapsule
    ? parts.findIndex((part) => part.type === "tool-call" && part.toolName === "dispatch_subagent")
    : -1;
  return assistantPartRanges(parts).flatMap((range): AssistantPartRange[] => {
    if (!hideSubagentCalls || range.type !== "tools") return [range];
    const visible: AssistantPartRange[] = [];
    let start = -1;
    for (let index = range.startIndex; index < range.endIndex; index++) {
      const part = parts[index];
      if (part?.type === "tool-call" && part.toolName === "dispatch_subagent") {
        if (start >= 0) visible.push({ ...range, startIndex: start, endIndex: index });
        if (index === firstDispatchIndex) visible.push({ type: "subagents", index });
        start = -1;
      } else if (start < 0) start = index;
    }
    if (start >= 0) visible.push({ ...range, startIndex: start, endIndex: range.endIndex });
    return visible;
  });
}
