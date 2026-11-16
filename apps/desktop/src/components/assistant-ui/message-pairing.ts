import { isAgentCommunicationThreadMessage } from "../../lib/agent-communication";

export interface PairableMessage {
  id: string;
  role: string;
  parentId: string | null;
  status?: { type?: string };
  metadata?: { custom?: Record<string, unknown> };
}

export function pairMessageIds(messages: readonly PairableMessage[]) {
  const userIdByAssistant = new Map<string, string>();
  for (let index = 1; index < messages.length; index++) {
    const user = messages[index - 1];
    const assistant = messages[index];
    // An agent-to-agent message is stored as a user turn but is not the
    // person's prompt; pairing it would hide that bubble from the transcript.
    if (user?.role === "user" && !isAgentCommunicationThreadMessage(user)
      && assistant?.role === "assistant" && assistant.status?.type !== "running" && assistant.parentId === user.id) {
      userIdByAssistant.set(assistant.id, user.id);
    }
  }
  return userIdByAssistant;
}
