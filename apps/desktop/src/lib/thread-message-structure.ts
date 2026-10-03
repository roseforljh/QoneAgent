import type { ThreadMessage } from "@assistant-ui/react";

export function createMessageStructureSelector(includeSettledContent = false) {
  let previous: readonly ThreadMessage[] = [];
  const details = (message: ThreadMessage) => message as ThreadMessage & {
    parentId?: string | null;
    status?: { type?: string };
  };
  return (messages: readonly ThreadMessage[]) => {
    if (previous.length === messages.length && messages.every((message, index) => {
      const saved = previous[index]!;
      const savedDetails = details(saved);
      const nextDetails = details(message);
      return saved.id === message.id && saved.role === message.role && savedDetails.parentId === nextDetails.parentId
        && saved.createdAt.getTime() === message.createdAt.getTime()
        && savedDetails.status?.type === nextDetails.status?.type
        && (!includeSettledContent || nextDetails.status?.type === "running" || saved.content === message.content && saved.attachments === message.attachments);
    })) return previous;
    previous = messages;
    return previous;
  };
}
