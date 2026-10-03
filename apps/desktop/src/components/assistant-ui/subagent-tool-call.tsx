import { useAuiState, type PartState } from "@assistant-ui/react";
import { useConversationStore } from "../../lib/conversation-context";
import { messageById, toolCallById } from "../../lib/store-indexes";
import { useLocale } from "../../localization";
import { ToolCall } from "./elements/tool-call";
import type { ExecutionIcon } from "./execution-icons";
import { openSubagent, subagentForTool } from "./subagent-navigation";
import { toolOperationLabels, toolPreparationLabel } from "./tool-action-summary";
import { toolActivity } from "./tool-call-display";

export interface SubagentToolCallProps {
  part: Extract<PartState, { type: "tool-call" }>;
  step: { verb: string; icon?: ExecutionIcon };
  prepared?: boolean;
  showIcon?: boolean;
  messageRunning: boolean;
}

/** Reuse the existing child-title link; child output belongs to its side conversation. */
export function SubagentToolCall({ part, step, prepared = false, showIcon = false, messageRunning }: SubagentToolCallProps) {
  const { locale, t } = useLocale();
  const call = useConversationStore((state) => toolCallById(state.toolCalls, part.toolCallId));
  const messageId = useAuiState((state) => state.message.id);
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const parentRunId = useConversationStore((state) => messageId === "streaming" ? state.activeRunId : messageById(state.messages, messageId)?.runId);
  const childId = useConversationStore((state) => subagentForTool(part, call?.args, state.subagents, sessionId, parentRunId)?.id);
  const childTitle = useConversationStore((state) => subagentForTool(part, call?.args, state.subagents, sessionId, parentRunId)?.title);
  const status = toolActivity(part, call, prepared, messageRunning);
  const labels = toolOperationLabels(part, step.verb, locale);
  const activeLabel = status === "generating" ? toolPreparationLabel(part, step, locale)
    : status === "queued" ? t("chat.toolQueued")
      : status === "waiting" ? t("chat.toolApprovalPending") : labels.active;
  const label = status === "failed" ? t("chat.toolActionFailed", { operation: step.verb })
    : status === "queued" || status === "waiting" ? activeLabel : labels.completed;
  return <ToolCall icon={showIcon ? step.icon : undefined} label={label} activeLabel={activeLabel} query=""
    targetAction={childId && childTitle && sessionId ? {
      label: childTitle,
      ariaLabel: locale === "zh-CN" ? `打开子代理：${childTitle}` : `Open subagent: ${childTitle}`,
      onClick: () => openSubagent(childId, sessionId),
    } : undefined}
    result={null} canExpand={false} open={false} onOpenChange={() => {}}
    running={status === "running" || status === "generating"} pending={status === "queued" || status === "generating"}
    waiting={status === "waiting"} failed={status === "failed"} className="min-w-0 max-w-none flex-1" />;
}
