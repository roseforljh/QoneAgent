import type { SubagentRunInfo } from "@qone/protocol";

type Message = {
  id: string;
  role: string;
  runId?: string;
  parts?: readonly { type: string; toolCallId?: string }[];
};

/** A child's capsule belongs to the assistant segment that dispatched it. */
export function subagentsForAssistantMessage(
  subagents: readonly SubagentRunInfo[],
  messages: readonly Message[],
  runId: string | undefined,
  messageId: string,
  currentParts: readonly { type: string; toolCallId?: string }[],
): SubagentRunInfo[] {
  if (!runId) return [];
  const assistantMessages = messages.filter((message) => message.role === "assistant" && message.runId === runId);
  const currentToolIds = new Set(currentParts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId));
  return subagents.filter((subagent) => {
    if (subagent.parentRunId !== runId) return false;
    const owner = assistantMessages.find((message) => message.parts?.some(
      (part) => part.type === "tool-call" && part.toolCallId === subagent.toolCallId,
    ));
    if (owner) return owner.id === messageId;
    if (currentToolIds.has(subagent.toolCallId)) return true;
    return (assistantMessages[0]?.id ?? "streaming") === messageId;
  });
}
