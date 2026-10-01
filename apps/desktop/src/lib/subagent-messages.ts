import type { ThreadAssistantMessagePart, ThreadMessage } from "@assistant-ui/react";
import type { SubagentRunInfo } from "@qone/protocol";
import { assistantMessageContent } from "./assistant-message-parts";

const running = (status: SubagentRunInfo["status"]) => ["created", "running", "waiting_approval", "paused"].includes(status);

type SavedMessage = NonNullable<SubagentRunInfo["messages"]>[number];
const savedMessages = new WeakMap<SavedMessage, { task?: string; converted: ThreadMessage }>();

function savedMessage(message: SavedMessage, task: string): ThreadMessage | undefined {
  if (message.internal || (message.role !== "user" && message.role !== "assistant")) return undefined;
  const initialTask = message.role === "user" && message.sequence === 0 ? task : undefined;
  const cached = savedMessages.get(message);
  if (cached && cached.task === initialTask) return cached.converted;
  const converted: ThreadMessage = message.role === "user" ? {
    id: message.id, role: "user", createdAt: new Date(message.createdAt),
    content: [{ type: "text", text: initialTask ?? message.content }], attachments: [], metadata: { custom: {} },
  } : {
    id: message.id, role: "assistant", createdAt: new Date(message.createdAt),
    content: assistantMessageContent({ content: message.content, parts: message.parts }, [], false) as readonly ThreadAssistantMessagePart[],
    status: { type: "complete", reason: "stop" },
    metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
  };
  savedMessages.set(message, { task: initialTask, converted });
  return converted;
}

export function subagentMessages(item: SubagentRunInfo): ThreadMessage[] {
  const isRunning = running(item.status);
  if (item.messages?.length) {
    const savedParts = item.messages.reduce((count, message) => count + (message.role === "assistant" ? message.parts?.length ?? 0 : 0), 0);
    const unsavedParts = item.parts.slice(savedParts);
    const finalStatus = isRunning ? { type: "running" as const }
      : item.status === "failed" ? { type: "incomplete" as const, reason: "error" as const, error: item.error }
        : item.status === "cancelled" || item.status === "interrupted" ? { type: "incomplete" as const, reason: "cancelled" as const }
          : { type: "complete" as const, reason: "stop" as const };
    const transcript = item.messages.flatMap((message) => {
      const converted = savedMessage(message, item.task);
      return converted ? [converted] : [];
    });
    if (isRunning || unsavedParts.length || item.streaming) {
      const converted = assistantMessageContent({ content: item.streaming || "", parts: unsavedParts.length ? unsavedParts : undefined }, [], isRunning);
      transcript.push({
        id: `${item.id}:live`, role: "assistant", createdAt: new Date(),
        content: typeof converted === "string" ? [{ type: "text", text: converted }] : converted as readonly ThreadAssistantMessagePart[],
        status: finalStatus,
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
      });
    }
    return transcript;
  }
  const groups: (typeof item.parts)[] = [];
  for (const part of item.parts) {
    const last = groups.at(-1);
    if (last?.[0]?.messageSequence === part.messageSequence) last.push(part);
    else groups.push([part]);
  }
  const hasPending = Boolean(item.streaming) || groups.length === 0;
  const messageParts = groups.map((parts, index) => ({ id: `${item.id}:message:${parts[0]!.messageSequence}`, parts, last: index === groups.length - 1 && !hasPending }));
  if (hasPending) messageParts.push({ id: `${item.id}:pending`, parts: [], last: true });
  const finalStatus = isRunning ? { type: "running" as const }
    : item.status === "failed" ? { type: "incomplete" as const, reason: "error" as const, error: item.error }
      : item.status === "cancelled" || item.status === "interrupted" ? { type: "incomplete" as const, reason: "cancelled" as const }
        : { type: "complete" as const, reason: "stop" as const };
  return [
    {
      id: `${item.id}:task`, role: "user", createdAt: new Date(item.startedAt),
      content: [{ type: "text", text: item.task }], attachments: [], metadata: { custom: {} },
    },
    ...messageParts.map(({ id, parts, last }): ThreadMessage => ({
      id, role: "assistant", createdAt: new Date(item.startedAt),
      content: (() => {
        const converted = assistantMessageContent({ content: last && item.streaming ? item.streaming : parts.length ? "" : item.content, parts: parts.length ? parts : undefined }, [], isRunning && last);
        return typeof converted === "string" ? [{ type: "text" as const, text: converted }] : converted as readonly ThreadAssistantMessagePart[];
      })(),
      status: last ? finalStatus : { type: "complete", reason: "stop" },
      metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
    })),
  ];
}
