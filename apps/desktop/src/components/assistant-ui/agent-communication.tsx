import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import type { AgentCommunicationInfo } from "@qone/protocol";
import { CodexIcon } from "../ui/CodexIcon";
import agentSwitchIcon from "../../assets/codex-icons/arrow-left-arrow-right-light-16.svg";
import recoveryIcon from "../../assets/codex-icons/arrow-rotate-counterclockwise-light-16.svg";
import scheduleIcon from "../../assets/codex-icons/clock-light-16.svg";
import { MarkdownText } from "./markdown-text";
import { BackgroundJobRow } from "./background-job-view";
import "./agent-communication.css";

export function useAgentCommunication() {
  return useAuiState(state => state.message.metadata.custom?.qoneAgentCommunication as AgentCommunicationInfo | undefined);
}

/** 代理与系统消息保留在标准消息树中，但视觉克制且不冒充用户输入。 */
export function AgentCommunication({ communication }: { communication: AgentCommunicationInfo }) {
  if (communication.backgroundJobId) return <MessagePrimitive.Root className="q-message-root mx-auto w-full q-thread-content">
    <BackgroundJobRow jobId={communication.backgroundJobId} showIcon />
  </MessagePrimitive.Root>;

  // 重启恢复等系统级提示以单行静默样式呈现，与上下文压缩提示保持一致。
  if (communication.fromId === "qone") return (
    <MessagePrimitive.Root
      className="q-message-root mx-auto w-full q-thread-content q-agent-communication-system"
      data-agent-from={communication.fromId}
      data-agent-to={communication.toId}
    >
      <CodexIcon src={recoveryIcon} className="q-agent-communication-icon" />
      <div className="q-agent-communication-content"><MessagePrimitive.Parts components={{ Text: MarkdownText }} /></div>
    </MessagePrimitive.Root>
  );

  const iconSrc = communication.fromId.startsWith("schedule:") ? scheduleIcon : agentSwitchIcon;

  return (
    <MessagePrimitive.Root
      className="q-message-root mx-auto w-full q-thread-content q-agent-communication"
      data-agent-from={communication.fromId}
      data-agent-to={communication.toId}
    >
      <div className="q-agent-communication-heading">
        <CodexIcon src={iconSrc} className="q-agent-communication-icon" />
        <span className="q-agent-communication-peer">{communication.fromTitle}</span>
        <span className="q-agent-communication-arrow" aria-hidden="true">→</span>
        <span className="q-agent-communication-peer">{communication.toTitle}</span>
      </div>
      <div className="q-agent-communication-content"><MessagePrimitive.Parts components={{ Text: MarkdownText }} /></div>
    </MessagePrimitive.Root>
  );
}
