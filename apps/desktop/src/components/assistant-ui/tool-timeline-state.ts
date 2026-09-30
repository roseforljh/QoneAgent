import type { ToolCall } from "../../store";
import { toolActivity } from "./tool-call-display";

type ToolStatePart = { toolCallId: string; result?: unknown; isError?: boolean; status?: { type: string } };

/** Prefer the latest executing call; when none is executing, show the latest prepared call. */
export function selectActiveToolIndex(
  parts: readonly ToolStatePart[],
  calls: ReadonlyMap<string, Pick<ToolCall, "status">>,
  preparedIds: ReadonlySet<string>,
  messageRunning: boolean,
): number {
  let preparedIndex = -1;
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    const activity = toolActivity(part, calls.get(part.toolCallId), preparedIds.has(part.toolCallId), messageRunning);
    if (activity === "running" || activity === "waiting") return index;
    if (preparedIndex < 0 && (activity === "queued" || activity === "generating")) preparedIndex = index;
  }
  return preparedIndex;
}
