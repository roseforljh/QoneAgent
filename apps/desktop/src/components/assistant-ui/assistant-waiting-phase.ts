import { ACTIVITY_TITLE_TOOL, activityTitleFromArgs, type AssistantMessagePart } from "@qone/protocol";
import type { ToolCall } from "../../store";

export type AssistantWaitingPhase = "preparing" | "waiting" | "thinking";

export function assistantWaitingPhase({
  messageRunning,
  compacting,
  hasCurrentText,
  hasReasoning,
  parts,
  toolCallsById,
  requestStartedAt,
}: {
  messageRunning: boolean;
  compacting: boolean;
  hasCurrentText: boolean;
  hasReasoning: boolean;
  parts: readonly AssistantMessagePart[];
  toolCallsById: ReadonlyMap<string, Pick<ToolCall, "status" | "args">>;
  requestStartedAt?: number;
}): AssistantWaitingPhase | undefined {
  if (!messageRunning || compacting || hasCurrentText || hasReasoning) return undefined;
  if (parts.some((part) => {
    if (part.type !== "tool-call") return false;
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "running" || call?.status === "waiting"
      || (!call && part.result === undefined && !part.isError);
  })) return undefined;

  // An authored stage heading owns the shimmer until prose/media closes it.
  for (let index = parts.length - 1; index >= 0; index--) {
    const part = parts[index]!;
    if (part.type === "text" || part.type === "image" || (part.type === "tool-call" && part.toolName === "present" && !part.isError)) break;
    if (part.type !== "tool-call" || part.toolName !== ACTIVITY_TITLE_TOOL) continue;
    const call = toolCallsById.get(part.toolCallId);
    if (!part.isError && call?.status !== "failed" && activityTitleFromArgs(call?.args ?? part.args)) return undefined;
  }

  const last = parts.at(-1);
  if (last?.type === "tool-call" && last.toolName !== "present") return "thinking";
  return requestStartedAt === undefined ? "preparing" : "waiting";
}
