export interface PairableMessage {
  id: string;
  role: string;
  parentId: string | null;
}

export function pairMessageIds(messages: readonly PairableMessage[]) {
  const userIdByAssistant = new Map<string, string>();
  for (let index = 1; index < messages.length; index++) {
    const user = messages[index - 1];
    const assistant = messages[index];
    if (user?.role === "user" && assistant?.role === "assistant" && assistant.parentId === user.id) {
      userIdByAssistant.set(assistant.id, user.id);
    }
  }
  return userIdByAssistant;
}
