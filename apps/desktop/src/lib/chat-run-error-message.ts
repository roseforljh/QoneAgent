import type { ChatMessage, ChatRunError } from "../store";

export function chatRunErrorMessageId(userMessageId: string): string {
  return `run-error:${userMessageId}`;
}

export function insertChatRunErrorMessage(messages: readonly ChatMessage[], error: ChatRunError, content: string): ChatMessage[] {
  const userIndex = messages.findIndex((message) => message.id === error.userMessageId && message.role === "user");
  if (userIndex < 0) return [...messages];

  // An agent-to-agent message is a user-role row but not a turn boundary; the
  // error belongs after the last real user turn before it.
  const nextUserOffset = messages.slice(userIndex + 1).findIndex((message) => message.role === "user" && !message.communication);
  const insertAt = nextUserOffset < 0 ? messages.length : userIndex + 1 + nextUserOffset;
  const preceding = messages[insertAt - 1];
  const failedMessage: ChatMessage = {
    id: chatRunErrorMessageId(error.userMessageId),
    role: "assistant",
    content,
    createdAt: preceding?.createdAt ?? Date.now(),
  };
  return [...messages.slice(0, insertAt), failedMessage, ...messages.slice(insertAt)];
}
