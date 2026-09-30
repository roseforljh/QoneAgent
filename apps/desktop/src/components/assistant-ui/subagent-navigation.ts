import type { SubagentRunInfo } from "@qone/protocol";

type ToolRef = { toolName: string; toolCallId: string; args?: unknown };

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
  if (!sessionId) return undefined;
  const inSession = subagents.filter((item) => item.parentSessionId === sessionId);
  if (part.toolName === "dispatch_subagent") return inSession.find((item) => item.parentRunId === parentRunId && item.toolCallId === part.toolCallId);
  if (part.toolName !== "inspect_subagent" && part.toolName !== "control_subagent" && part.toolName !== "wait_subagent") return undefined;
  const runId = runIdFromArgs(part.args) ?? runIdFromArgs(callArgs);
  return runId ? inSession.find((item) => item.id === runId) : undefined;
}

export const OPEN_SUBAGENT_EVENT = "qone-open-subagents";

export function openSubagent(runId: string, sessionId: string): void {
  window.dispatchEvent(new CustomEvent(OPEN_SUBAGENT_EVENT, { detail: { runId, sessionId } }));
}
