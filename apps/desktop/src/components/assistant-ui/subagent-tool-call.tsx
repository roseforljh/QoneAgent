import { useAuiState, type PartState } from "@assistant-ui/react";
import { useConversationStore } from "../../lib/conversation-context";
import { messageById, toolCallById } from "../../lib/store-indexes";
import { useLocale } from "../../localization";
import { ToolCall } from "./elements/tool-call";
import type { ExecutionIcon } from "./execution-icons";
import type { SubagentRunInfo } from "@qone/protocol";
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

function isActive(status: SubagentRunInfo["status"] | undefined): boolean {
  return status === "created" || status === "running" || status === "waiting_approval" || status === "paused";
}

/** Reuse the existing child-title link; child output belongs to its side conversation. */
export function SubagentToolCall({ part, step, prepared = false, showIcon = false, messageRunning }: SubagentToolCallProps) {
  const { locale, t } = useLocale();
  const call = useConversationStore((state) => toolCallById(state.toolCalls, part.toolCallId));
  const messageId = useAuiState((state) => state.message.id);
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const parentRunId = useConversationStore((state) => messageId === "streaming" ? state.activeRunId : messageById(state.messages, messageId)?.runId);
  const child = useConversationStore((state) => subagentForTool(part, call?.args, state.subagents, sessionId, parentRunId));
  const childId = child?.id;
  const childTitle = child?.title;
  const status = toolActivity(part, call, prepared, messageRunning);
  const labels = toolOperationLabels(part, step.verb, locale);
  const activeLabel = status === "generating" ? toolPreparationLabel(part, step, locale)
    : status === "queued" ? t("chat.toolQueued")
      : status === "waiting" ? t("chat.toolApprovalPending") : labels.active;
  const childLabelKey = child ? child.status === "completed" ? "chat.subagentCompleted"
    : child.status === "failed" ? "chat.subagentFailed"
      : child.status === "cancelled" ? "chat.subagentCancelled"
        : child.status === "interrupted" ? "chat.subagentInterrupted"
          : child.retryCount > 0 || child.dependencyState === "retry_required" ? "chat.subagentContinuing"
            : "chat.subagentWaiting" : undefined;
  const childLabel = childLabelKey ? t(childLabelKey) : undefined;
  const label = childLabel ?? (status === "failed" ? t("chat.toolActionFailed", { operation: step.verb })
    : status === "queued" || status === "waiting" ? activeLabel : labels.completed);
  const visibleActiveLabel = childLabel ?? activeLabel;
  const childActive = isActive(child?.status);
  const childWaiting = child?.status === "created" || child?.status === "waiting_approval" || child?.dependencyState === "retry_required";
  return <ToolCall icon={showIcon ? step.icon : undefined} label={label} activeLabel={visibleActiveLabel} query=""
    targetAction={childId && childTitle && sessionId ? {
      label: childTitle,
      ariaLabel: locale === "zh-CN" ? `打开子代理：${childTitle}` : `Open subagent: ${childTitle}`,
      onClick: () => openSubagent(childId, sessionId),
    } : undefined}
    result={null} canExpand={false} open={false} onOpenChange={() => {}}
    running={childActive || status === "running" || status === "generating"} pending={!child && (status === "queued" || status === "generating")}
    waiting={childWaiting || (!child && status === "waiting")} failed={child?.status === "failed" || (!child && status === "failed")} className="min-w-0 max-w-none flex-1" />;
}
