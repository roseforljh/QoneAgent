import type { SubagentRunInfo } from "@qone/protocol";
import { subagentById, subagentByParentTool, subagentsForParent } from "../../lib/store-indexes";

type ToolRef = { toolName: string; toolCallId: string; args?: unknown };

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

function isActive(status: SubagentRunInfo["status"]): boolean {
  return status === "created" || status === "running" || status === "waiting_approval" || status === "paused";
}

export const OPEN_SUBAGENT_EVENT = "qone-open-subagents";

export function openSubagent(runId: string, sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_EVENT, { detail: { runId, sessionId } }));
}
