import type { SubagentRunInfo } from "@qone/protocol";

type Message = {
  id: string;
  role: string;
  runId?: string;
  parts?: readonly { type: string; toolCallId?: string }[];
};
const ownership = new WeakMap<readonly Message[], Map<string, { first?: string; tools: Map<string, string> }>>();

function owners(messages: readonly Message[], runId: string) {
  let runs = ownership.get(messages);
  if (!runs) {
    runs = new Map();
    for (const message of messages) {
      if (message.role !== "assistant" || !message.runId) continue;
      let owner = runs.get(message.runId);
      if (!owner) runs.set(message.runId, owner = { first: message.id, tools: new Map() });
      for (const part of message.parts ?? []) if (part.type === "tool-call" && part.toolCallId && !owner.tools.has(part.toolCallId)) owner.tools.set(part.toolCallId, message.id);
    }
    ownership.set(messages, runs);
  }
  return runs.get(runId);
}

/** Child media belongs to the assistant segment that dispatched it. */
export function subagentsForAssistantMessage(
  subagents: readonly SubagentRunInfo[],
  messages: readonly Message[],
  runId: string | undefined,
  messageId: string,
  currentParts: readonly { type: string; toolCallId?: string }[],
): SubagentRunInfo[] {
  if (!runId || !subagents.length) return [];
  const assistantOwners = owners(messages, runId);
  const currentToolIds = new Set(currentParts.filter((part) => part.type === "tool-call").map((part) => part.toolCallId));
  return subagents.filter((subagent) => {
    if (subagent.parentRunId !== runId) return false;
    const owner = assistantOwners?.tools.get(subagent.toolCallId);
    if (owner) return owner === messageId;
    if (currentToolIds.has(subagent.toolCallId)) return true;
    return (assistantOwners?.first ?? "streaming") === messageId;
  });
}

export function createOwnedSubagentSelector() {
  let previous: { subagents: SubagentRunInfo[]; childRunIds: string[] } | undefined;
  return (subagents: readonly SubagentRunInfo[], messages: readonly Message[], runId: string | undefined, messageId: string, currentParts: readonly { type: string; toolCallId?: string }[]) => {
    const owned = subagentsForAssistantMessage(subagents, messages, runId, messageId, currentParts);
    const descendants = new Set(owned.map((item) => item.id));
    const children = new Map<string, string[]>();
    for (const item of subagents) {
      let ids = children.get(item.parentRunId);
      if (!ids) children.set(item.parentRunId, ids = []);
      ids.push(item.id);
    }
    const queue = [...descendants];
    for (let index = 0; index < queue.length; index++) for (const id of children.get(queue[index]!) ?? []) {
      if (!descendants.has(id)) { descendants.add(id); queue.push(id); }
    }
    const childRunIds = [...descendants];
    if (previous && previous.subagents.length === owned.length && owned.every((item, index) => item === previous!.subagents[index])
      && childRunIds.length === previous.childRunIds.length && childRunIds.every((id, index) => id === previous!.childRunIds[index])) return previous;
    previous = { subagents: owned, childRunIds };
    return previous;
  };
}
