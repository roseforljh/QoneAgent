import type { PartState } from "@assistant-ui/react";

export type AssistantPartRange =
  | { type: "text"; index: number }
  | { type: "tools"; startIndex: number; endIndex: number }
  | { type: "presentation"; index: number };

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
    if (part.type === "text") {
      ranges.push({ type: "text", index });
      index++;
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
