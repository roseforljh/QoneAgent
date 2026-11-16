/**
 * A message between agents is stored as `role: "user"` so the model sees it as
 * input, but it is not a turn the person typed. Anything that treats a user
 * message as "the user's turn" (pairing, retry, history, scroll anchoring)
 * must skip these.
 */
export function isAgentCommunicationMessage(message: { communication?: unknown } | undefined): boolean {
  return Boolean(message?.communication);
}

/** The same marker after conversion into an assistant-ui thread message. */
export function isAgentCommunicationThreadMessage(message: { metadata?: { custom?: Record<string, unknown> } } | undefined): boolean {
  return Boolean(message?.metadata?.custom?.qoneAgentCommunication);
}

/** The latest turn the person actually typed, without copying the history. */
export function lastUserTurn<T extends { role: string; communication?: unknown }>(messages: readonly T[]): T | undefined {
  for (let index = messages.length - 1; index >= 0; index--) {
    const message = messages[index]!;
    if (message.role === "user" && !message.communication) return message;
  }
  return undefined;
}
