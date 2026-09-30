import { CodexChevronRightIcon as ChevronRightIcon } from "./execution-icons";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useAuiState } from "@assistant-ui/react";
import { useMemo, useRef, type FC, type ReactNode } from "react";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { useLocale } from "../../localization";
import { formatDuration } from "../../lib/utils";
import { useStore } from "../../store";
import type { AssistantPartRange } from "./assistant-part-ranges";
import { executionCollapsed, useExecutionDisclosureState } from "./execution-disclosure-state";
import "./assistant-execution.css";

interface AssistantExecutionProps {
  ranges: readonly AssistantPartRange[];
  finalAnswerStarted: boolean;
  children: ReactNode;
}

export const AssistantExecution: FC<AssistantExecutionProps> = ({ ranges, finalAnswerStarted, children }) => {
  const { locale, t } = useLocale();
  const reduceMotion = useReducedMotion();
  const messageId = useAuiState((state) => state.message.id);
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const parts = useAuiState((state) => state.message.parts);
  const sessionId = useStore((state) => state.currentSessionId);
  const activeRunId = useStore((state) => state.activeRunId);
  const messageRunId = useStore((state) => state.messages.find((message) => message.id === messageId)?.runId);
  const runs = useStore((state) => state.runs);
  const toolCalls = useStore((state) => state.toolCalls);

  const toolParts = useMemo(() => {
    const visibleParts: Extract<typeof parts[number], { type: "tool-call" }>[] = [];
    for (const range of ranges) {
      if (range.type !== "tools") continue;
      for (const part of parts.slice(range.startIndex, range.endIndex)) {
        if (part.type === "tool-call") visibleParts.push(part);
      }
    }
    return visibleParts;
  }, [parts, ranges]);

  const toolCallsById = useMemo(
    () => new Map(toolCalls.map((call) => [call.toolCallId, call] as const)),
    [toolCalls],
  );
  const runId = messageId === "streaming" ? activeRunId : messageRunId;
  const run = runId ? runs.find((item) => item.id === runId) : undefined;
  const runFinished = Boolean(run && !["created", "running", "waiting_approval", "paused"].includes(run.status));
  const allToolsFinished = toolParts.every((part) => {
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "success"
      || call?.status === "failed"
      || part.result !== undefined
      || part.isError;
  });
  const reasoningRunning = messageRunning && ranges.some((range) => {
    if (range.type !== "reasoning") return false;
    const part = parts[range.index];
    return part?.type === "reasoning" && part.status.type === "running";
  });
  const activitySettled = allToolsFinished && !reasoningRunning;
  const executionFinished = runFinished || !messageRunning || (activitySettled && finalAnswerStarted);
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
  const workedDuration = executionFinished && Number.isFinite(startedAt) && completedAt > startedAt
    ? formatDuration((completedAt - startedAt) / 1000, locale)
    : undefined;
  const executionLabel = executionFinished
    ? workedDuration ? t("chat.executionWorkedFor", { duration: workedDuration }) : toolParts.length ? t("chat.executionCompleted", { count: toolParts.length }) : t("chat.reasoning")
    : messageRunning
    ? activeToolIndex >= 0
      ? t("chat.executionRunning", { current: activeToolIndex + 1 })
      : reasoningRunning ? t("chat.reasoningActive") : t("chat.executionFinishing")
    : t("chat.executionFinishing");
  const finishing = !executionFinished && activeToolIndex < 0;

  const firstRange = ranges[0];
  const firstIndex = firstRange && ("index" in firstRange ? firstRange.index : firstRange.startIndex);
  const disclosureKey = JSON.stringify([sessionId, runId ?? messageId, firstIndex]);
  const override = useExecutionDisclosureState((state) => state.overrides[disclosureKey]);
  const setCollapsed = useExecutionDisclosureState((state) => state.setCollapsed);

  const cancelled = run?.status === "cancelled" || run?.status === "interrupted";
  const canCollapse = finalAnswerStarted && !cancelled;
  const collapsed = executionCollapsed(override, finalAnswerStarted, activitySettled || !messageRunning, cancelled);
  const visibleOpen = !canCollapse || !collapsed;
  const disclosureRef = useRef<HTMLDivElement>(null);
  const statusLabel = <>{executionLabel}{finishing && <span className="q-execution-dots text-primary/70" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>}</>;

  return (
    <div data-slot="assistant-execution" className="q-assistant-execution w-full py-1">
      <Collapsible ref={disclosureRef} open={visibleOpen} onOpenChange={(nextOpen) => { setCollapsed(disclosureKey, !nextOpen); }} className="w-full">
        {canCollapse ? <CollapsibleTrigger
          aria-label={t("chat.executionToggle")}
          className="group/execution-trigger text-muted-foreground/75 hover:text-foreground inline-flex items-center gap-1.5 py-0.5 text-start text-[13px] font-medium tabular-nums transition-colors outline-none bg-transparent"
        >
          <span>{statusLabel}</span>
          <ChevronRightIcon className="size-3.5 shrink-0 opacity-50 transition-transform duration-200 group-data-[state=open]/execution-trigger:rotate-90 group-hover/execution-trigger:opacity-80 motion-reduce:transition-none" />
        </CollapsibleTrigger> : <div className="text-muted-foreground/75 py-0.5 text-[13px] font-medium tabular-nums">
          {statusLabel}
        </div>}
        <AnimatePresence initial={false}>
          {visibleOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -6 }}
              animate={{ height: "auto", opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -6, transition: { duration: reduceMotion ? 0 : 0.15 } }}
              transition={{ duration: reduceMotion ? 0 : 0.22, ease: [0.32, 0.72, 0, 1] }}
              className="overflow-hidden outline-none"
            >
              <div className="flex flex-col gap-1.5 pt-2 pb-1 pl-2.5 ml-1.5 border-l border-border/40 dark:border-border/30">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </Collapsible>
    </div>
  );
};
