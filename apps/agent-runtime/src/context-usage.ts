import { estimateTokens, type AgentSession } from "@earendil-works/pi-coding-agent";

function storedContextTokens(session: AgentSession): number {
  return session.getContextUsage()?.tokens
    ?? session.messages.reduce((total, message) => total + estimateTokens(message), 0);
}

export function contextTokens(session: AgentSession): number {
  const streaming = session.agent?.state.streamingMessage;
  return storedContextTokens(session) + (streaming ? estimateTokens(streaming) : 0);
}

/** Pi keeps the current streamed message outside session.messages until message_end. */
export function subscribeContextUsage(
  session: AgentSession,
  emit: (usage: { tokens: number; contextWindow: number }) => void,
): () => void {
  let baseTokens: number | undefined;
  let previous: { tokens: number; contextWindow: number } | undefined;
  return session.subscribe((event) => {
    let tokens: number;
    if (event.type === "message_update") {
      // Reuse the history total while streaming; only estimate the current message.
      baseTokens ??= storedContextTokens(session);
      tokens = baseTokens + estimateTokens(event.message);
    } else if (event.type === "message_start" || event.type === "message_end"
      || event.type === "agent_start" || event.type === "agent_end" || event.type === "compaction_end") {
      baseTokens = storedContextTokens(session);
      tokens = baseTokens + (event.type === "message_start" ? estimateTokens(event.message) : 0);
      if (event.type === "agent_start") previous = undefined;
    } else return;
    const contextWindow = session.model?.contextWindow;
    if (!contextWindow || (previous?.tokens === tokens && previous.contextWindow === contextWindow)) return;
    previous = { tokens, contextWindow };
    emit(previous);
  });
}
