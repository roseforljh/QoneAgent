import type { ThreadAssistantMessagePart, ThreadMessage } from "@assistant-ui/react";
import type { SubagentRunInfo } from "@qone/protocol";
import { assistantMessageContent } from "./assistant-message-parts";

const running = (status: SubagentRunInfo["status"]) => ["created", "running", "waiting_approval", "paused"].includes(status);

export function subagentMessages(item: SubagentRunInfo): ThreadMessage[] {
  const isRunning = running(item.status);
  if (item.messages?.length) {
    const savedParts = item.messages.reduce((count, message) => count + (message.role === "assistant" ? message.parts?.length ?? 0 : 0), 0);
    const unsavedParts = item.parts.slice(savedParts);
    const finalStatus = isRunning ? { type: "running" as const }
      : item.status === "failed" ? { type: "incomplete" as const, reason: "error" as const, error: item.error }
        : item.status === "cancelled" || item.status === "interrupted" ? { type: "incomplete" as const, reason: "cancelled" as const }
          : { type: "complete" as const, reason: "stop" as const };
    const transcript: ThreadMessage[] = item.messages.flatMap((message): ThreadMessage[] => {
      if (message.internal) return [];
      if (message.role === "user") return [{
        id: message.id, role: "user" as const, createdAt: new Date(message.createdAt),
        content: [{ type: "text" as const, text: message.sequence === 0 ? item.task : message.content }], attachments: [], metadata: { custom: {} },
      }];
      if (message.role !== "assistant") return [];
      const converted = assistantMessageContent({ content: message.content, parts: message.parts }, [], false);
      return [{
        id: message.id, role: "assistant" as const, createdAt: new Date(message.createdAt),
        content: typeof converted === "string" ? [{ type: "text" as const, text: converted }] : converted as readonly ThreadAssistantMessagePart[],
        status: { type: "complete" as const, reason: "stop" as const },
        metadata: { unstable_state: null, unstable_annotations: [], unstable_data: [], steps: [], custom: {} },
      }];
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
