import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import type { AgentCommunicationInfo } from "@qone/protocol";
import { useLocale } from "../../localization";
import { MarkdownText } from "./markdown-text";
import "./agent-communication.css";

export function useAgentCommunication() {
  return useAuiState(state => state.message.metadata.custom?.qoneAgentCommunication as AgentCommunicationInfo | undefined);
}

/** Agent messages stay in the standard message tree, but never impersonate a user. */
export function AgentCommunication({ communication }: { communication: AgentCommunicationInfo }) {
  const { t } = useLocale();
  return <MessagePrimitive.Root className="q-message-root q-agent-communication" data-agent-from={communication.fromId} data-agent-to={communication.toId}>
    <div className="q-agent-communication-heading">
      <span className="q-agent-communication-label">{t("subagent.communication")}</span>
      <strong>{communication.fromTitle}</strong><span aria-hidden="true">→</span><strong>{communication.toTitle}</strong>
    </div>
    <div className="q-agent-communication-content"><MessagePrimitive.Parts components={{ Text: MarkdownText }} /></div>
  </MessagePrimitive.Root>;
}
