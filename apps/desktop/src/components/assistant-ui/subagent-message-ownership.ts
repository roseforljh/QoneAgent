import type { SubagentRunInfo } from "@qone/protocol";

type Message = {
  id: string;
  role: string;
  runId?: string;
  parts?: readonly { type: string; toolCallId?: string }[];
};

/** Child media belongs to the assistant segment that dispatched it. */
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

export function createOwnedSubagentSelector() {
  let previous: { subagents: SubagentRunInfo[]; childRunIds: string[] } | undefined;
  return (subagents: readonly SubagentRunInfo[], messages: readonly Message[], runId: string | undefined, messageId: string, currentParts: readonly { type: string; toolCallId?: string }[]) => {
    const owned = subagentsForAssistantMessage(subagents, messages, runId, messageId, currentParts);
    const descendants = new Set(owned.map((item) => item.id));
    for (let changed = true; changed;) {
      changed = false;
      for (const item of subagents) if (descendants.has(item.parentRunId) && !descendants.has(item.id)) {
        descendants.add(item.id);
        changed = true;
      }
    }
    const childRunIds = [...descendants];
    if (previous && previous.subagents.length === owned.length && owned.every((item, index) => item === previous!.subagents[index])
      && childRunIds.length === previous.childRunIds.length && childRunIds.every((id, index) => id === previous!.childRunIds[index])) return previous;
    previous = { subagents: owned, childRunIds };
    return previous;
  };
}
