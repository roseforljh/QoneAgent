import type { SubagentRunInfo } from "@qone/protocol";
import { subagentById, subagentByParentTool, subagentsForParent } from "../../lib/store-indexes";

type ToolRef = { type?: string; toolName: string; toolCallId: string; args?: unknown };
type MessageWithParts = { runId?: string; parts?: readonly { type: string; toolCallId?: string; toolName?: string }[] };

const SUBAGENT_TOOLS = new Set(["dispatch_subagent", "run_subagent_workflow", "inspect_subagent", "control_subagent", "wait_subagent"]);

export function isSubagentTool(toolName: string): boolean {
  return SUBAGENT_TOOLS.has(toolName);
}

function runIdFromArgs(args: unknown): string | undefined {
  if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
  const runId = (args as { runId?: unknown }).runId;
  return typeof runId === "string" ? runId : undefined;
}

export function subagentForTool(
  part: ToolRef,
  callArgs: unknown,
  subagents: readonly SubagentRunInfo[],
  sessionId: string | undefined,
  parentRunId: string | undefined,
): SubagentRunInfo | undefined {
  if (!sessionId || !isSubagentTool(part.toolName)) return undefined;
  if (part.toolName === "dispatch_subagent") {
    const child = subagentByParentTool(subagents, parentRunId, part.toolCallId);
    return child?.parentSessionId === sessionId ? child : undefined;
  }
  if (part.toolName === "run_subagent_workflow") {
    return subagentsForParent(subagents, parentRunId)
      .filter((item) => item.parentSessionId === sessionId && item.toolCallId.startsWith("workflow:"))
      .sort((a, b) => Number(isActive(b.status)) - Number(isActive(a.status)) || b.startedAt - a.startedAt)[0];
  }
  const runId = runIdFromArgs(part.args) ?? runIdFromArgs(callArgs);
  const child = subagentById(subagents, runId);
  return child?.parentSessionId === sessionId ? child : undefined;
}

/**
 * A child has one visual entry: the creation/workflow entry owns its status.
 * inspect/control/wait calls are lifecycle operations on that same child and
 * must not create a second identical row in the parent timeline.
 */
export function hasSubagentCreationCall(
  messages: readonly MessageWithParts[],
  currentParts: readonly ToolRef[],
  child: SubagentRunInfo,
): boolean {
  const isCreation = (part: { type?: string; toolCallId?: string; toolName?: string }) => {
    if (part.type !== "tool-call") return false;
    if (part.toolName === "dispatch_subagent" && part.toolCallId === child.toolCallId) return true;
    return child.toolCallId.startsWith("workflow:") && part.toolName === "run_subagent_workflow";
  };
  return messages.some((message) => message.runId === child.parentRunId && (message.parts ?? []).some(isCreation))
    || currentParts.some(isCreation);
}

export function shouldRenderSubagentTool(
  part: ToolRef,
  child: SubagentRunInfo | undefined,
  messages: readonly MessageWithParts[],
  currentParts: readonly ToolRef[],
): boolean {
  if (!child || part.toolName === "dispatch_subagent" || part.toolName === "run_subagent_workflow") return true;
  return !hasSubagentCreationCall(messages, currentParts, child);
}

function isActive(status: SubagentRunInfo["status"]): boolean {
  return status === "created" || status === "running" || status === "waiting_approval" || status === "paused";
}

export const OPEN_SUBAGENT_EVENT = "qone-open-subagents";

export function openSubagent(runId: string, sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_EVENT, { detail: { runId, sessionId } }));
}
