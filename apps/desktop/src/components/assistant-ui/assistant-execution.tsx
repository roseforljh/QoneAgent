import { useConversationStore } from "../../lib/conversation-context";
import { CodexChevronRightIcon as ChevronRightIcon } from "./execution-icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useAuiState } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { useLocale } from "../../localization";
import { formatDuration } from "../../lib/utils";
import { ACTIVITY_TITLE_TOOL, type RunInfo } from "@qone/protocol";
import type { AssistantPartRange } from "./assistant-part-ranges";
import { executionCollapsed, useExecutionDisclosureState } from "./execution-disclosure-state";
import "./assistant-execution.css";

interface AssistantExecutionProps {
  ranges: readonly AssistantPartRange[];
  statusRanges?: readonly AssistantPartRange[];
  finalAnswerStarted: boolean;
  disclosureStartIndex?: number;
  showStatus?: boolean;
  statusAtStart?: boolean;
  children: ReactNode;
}

interface ExecutionStatusProps {
  run?: RunInfo;
  messageRunning: boolean;
  startedAt: number;
  completedAt: number;
  activeToolIndex: number;
  reasoningRunning: boolean;
  toolCount: number;
}

const ExecutionStatus: FC<ExecutionStatusProps> = ({ run, messageRunning, startedAt, completedAt, activeToolIndex, reasoningRunning, toolCount }) => {
  const { locale, t } = useLocale();
  const working = run ? run.status === "created" || run.status === "running" : messageRunning;
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!working || !Number.isFinite(startedAt)) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [working, startedAt]);

  const end = working ? now : completedAt;
  const duration = Number.isFinite(startedAt) && end > startedAt
    ? formatDuration((end - startedAt) / 1000, locale) : undefined;
  const status = run?.status === "paused" ? t("chat.executionPaused")
    : run?.status === "waiting_approval" ? t("chat.executionAwaitingApproval")
      : run?.status === "cancelled" || run?.status === "interrupted"
        ? duration ? t("chat.executionStoppedAfter", { duration }) : t("chat.executionStopped")
        : run?.status === "failed"
          ? duration ? t("chat.executionFailedAfter", { duration }) : t("chat.executionFailed")
          : working
            ? duration ? t("chat.executionWorkingFor", { duration })
              : activeToolIndex >= 0 ? t("chat.executionRunning", { current: activeToolIndex + 1 })
                : reasoningRunning ? t("chat.reasoningActive") : t("chat.executionFinishing")
            : duration ? t("chat.executionWorkedFor", { duration })
              : toolCount ? t("chat.executionCompleted", { count: toolCount }) : t("chat.reasoning");
  const finishing = working && !duration && activeToolIndex < 0;
  return <>{status}{finishing && <span className="q-execution-dots text-primary/70" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>}</>;
};

export const AssistantExecution: FC<AssistantExecutionProps> = ({ ranges, statusRanges = ranges, finalAnswerStarted, disclosureStartIndex, showStatus = true, statusAtStart = false, children }) => {
  const { t } = useLocale();
  const reduceMotion = useReducedMotion();
  const messageId = useAuiState((state) => state.message.id);
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const parts = useAuiState((state) => state.message.parts);
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const activeRunId = useConversationStore((state) => state.activeRunId);
  const messageRunId = useConversationStore((state) => state.messages.find((message) => message.id === messageId)?.runId);
  const runs = useConversationStore((state) => state.runs);
  const toolCalls = useConversationStore((state) => state.toolCalls);

  const toolParts = useMemo(() => {
    const visibleParts: Extract<typeof parts[number], { type: "tool-call" }>[] = [];
    for (const range of statusRanges) {
      if (range.type !== "tools") continue;
      for (const part of parts.slice(range.startIndex, range.endIndex)) {
        if (part.type === "tool-call" && part.toolName !== ACTIVITY_TITLE_TOOL) visibleParts.push(part);
      }
    }
    return visibleParts;
  }, [parts, statusRanges]);

  const toolCallsById = useMemo(
    () => new Map(toolCalls.map((call) => [call.toolCallId, call] as const)),
    [toolCalls],
  );
  const runId = messageId === "streaming" ? activeRunId : messageRunId;
  const run = runId ? runs.find((item) => item.id === runId) : undefined;
  const allToolsFinished = toolParts.every((part) => {
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "success"
      || call?.status === "failed"
      || part.result !== undefined
      || part.isError;
  });
  const reasoningRunning = messageRunning && statusRanges.some((range) => {
    if (range.type !== "reasoning") return false;
    const part = parts[range.index];
    return part?.type === "reasoning" && part.status.type === "running";
  });
  const activitySettled = allToolsFinished && !reasoningRunning;
  const activeToolIndex = useMemo(() => toolParts.findIndex((part) => {
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "running"
      || call?.status === "waiting"
      || (!call && part.result === undefined && !part.isError);
  }), [toolCallsById, toolParts]);
  let firstToolStartedAt = Infinity;
  let lastToolCompletedAt = 0;
  for (const part of toolParts) {
    const call = toolCallsById.get(part.toolCallId);
    if (call?.startedAt !== undefined) firstToolStartedAt = Math.min(firstToolStartedAt, call.startedAt);
    if (call?.completedAt !== undefined) lastToolCompletedAt = Math.max(lastToolCompletedAt, call.completedAt);
  }
  const completedAt = run?.completedAt ?? lastToolCompletedAt;
  const startedAt = run?.startedAt ?? firstToolStartedAt;

  const firstRange = ranges[0];
  const firstIndex = firstRange && ("index" in firstRange ? firstRange.index : firstRange.startIndex);
  const disclosureKey = JSON.stringify([sessionId, runId ?? messageId, disclosureStartIndex ?? firstIndex]);
  const override = useExecutionDisclosureState((state) => state.overrides[disclosureKey]);
  const setCollapsed = useExecutionDisclosureState((state) => state.setCollapsed);

  const cancelled = run?.status === "cancelled" || run?.status === "interrupted";
  const canCollapse = finalAnswerStarted && !cancelled;
  const collapsed = executionCollapsed(override, finalAnswerStarted, activitySettled || !messageRunning, cancelled);
  const visibleOpen = !canCollapse || !collapsed;
  const disclosureRef = useRef<HTMLDivElement>(null);
  const statusLabel = <ExecutionStatus run={run} messageRunning={messageRunning} startedAt={startedAt} completedAt={completedAt} activeToolIndex={activeToolIndex} reasoningRunning={reasoningRunning} toolCount={toolParts.length} />;
  const statusRow = showStatus && <div className="border-b border-border/50 pb-2">
    {canCollapse ? <CollapsibleTrigger
      aria-label={t("chat.executionToggle")}
      className="group/execution-trigger text-muted-foreground/75 hover:text-foreground inline-flex items-center gap-1.5 py-0.5 text-start text-[13px] font-medium tabular-nums transition-colors outline-none bg-transparent"
    >
      <span>{statusLabel}</span>
      <ChevronRightIcon className="size-3.5 shrink-0 opacity-50 transition-transform duration-200 group-data-[state=open]/execution-trigger:rotate-90 group-hover/execution-trigger:opacity-80 motion-reduce:transition-none" />
    </CollapsibleTrigger> : <div className="text-muted-foreground/75 py-0.5 text-[13px] font-medium tabular-nums">
      {statusLabel}
    </div>}
  </div>;

  return (
    <div data-slot="assistant-execution" className="q-assistant-execution w-full py-1">
      <Collapsible ref={disclosureRef} open={visibleOpen} onOpenChange={(nextOpen) => { setCollapsed(disclosureKey, !nextOpen); }} className="w-full">
        {(canCollapse || statusAtStart) && statusRow}
        <AnimatePresence initial={false}>
          {visibleOpen && ranges.length > 0 && (
            <motion.div
              initial={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -6 }}
              animate={{ height: "auto", opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -6, transition: { duration: reduceMotion ? 0 : 0.15 } }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
              className="overflow-hidden outline-none"
            >
              <div className="flex flex-col gap-2">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
        {!canCollapse && !statusAtStart && statusRow}
      </Collapsible>
    </div>
  );
};
