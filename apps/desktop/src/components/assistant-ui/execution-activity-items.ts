import type { PartState } from "@assistant-ui/react";
import type { ToolCall } from "../../store";
import type { AssistantPartRange } from "./assistant-part-ranges";
import { toolCallStatus } from "./tool-call-display";
import { ACTIVITY_TITLE_TOOL, activityTitleFromArgs } from "@qone/protocol";

export type ExecutionActivityItem =
  | { kind: "part"; range: AssistantPartRange }
  | { kind: "tools"; startIndex: number; endIndex: number; ranges: AssistantPartRange[]; title?: string };

const rangeStart = (range: AssistantPartRange) => "index" in range ? range.index : range.startIndex;
const rangeEnd = (range: AssistantPartRange) => "index" in range ? range.index + 1 : range.endIndex;

/** Group display activities without changing persisted part or compaction positions. */
export function executionActivityItems(
  ranges: readonly AssistantPartRange[],
  parts: readonly PartState[],
  calls: ReadonlyMap<string, Pick<ToolCall, "status" | "args">> = new Map(),
): ExecutionActivityItem[] {
  const items: ExecutionActivityItem[] = [];
  let pending: AssistantPartRange[] = [];
  let toolCount = 0;
  let title: string | undefined;
  let previousEnd = ranges[0] ? rangeStart(ranges[0]) : 0;
  const flush = () => {
    if (title || toolCount > 1) items.push({ kind: "tools", startIndex: rangeStart(pending[0]!), endIndex: rangeEnd(pending.at(-1)!), ranges: pending, ...(title ? { title } : {}) });
    else pending.forEach((range) => items.push({ kind: "part", range }));
    pending = [];
    toolCount = 0;
    title = undefined;
  };

  for (const range of ranges) {
    // An omitted whitespace/commentary part still closes a stage.
    if (parts.slice(previousEnd, rangeStart(range)).some((part) => part.type !== "reasoning" && part.type !== "tool-call")) flush();
    previousEnd = rangeEnd(range);
    if (range.type === "reasoning") {
      pending.push(range);
      continue;
    }
    if (range.type === "compaction" && title) {
      pending.push(range);
      continue;
    }
    if (range.type !== "tools") {
      flush();
      items.push({ kind: "part", range });
      continue;
    }
    for (let index = range.startIndex; index < range.endIndex; index++) {
      const part = parts[index];
      if (part?.type !== "tool-call") continue;
      const call = calls.get(part.toolCallId);
      const failed = toolCallStatus(part, call) === "failed";
      if (part.toolName === ACTIVITY_TITLE_TOOL && !failed) {
        const nextTitle = activityTitleFromArgs(call?.args ?? part.args);
        if (!nextTitle) continue;
        if (title || toolCount > 0) flush();
        title = nextTitle;
        pending.push({ type: "tools", startIndex: index, endIndex: index + 1 });
        continue;
      }
      if (failed && !title) {
        flush();
        items.push({ kind: "part", range: { type: "tools", startIndex: index, endIndex: index + 1 } });
        continue;
      }
      const last = pending.at(-1);
      if (last?.type === "tools" && last.endIndex === index) last.endIndex++;
      else pending.push({ type: "tools", startIndex: index, endIndex: index + 1 });
      toolCount++;
    }
  }
  flush();
  return items;
}
