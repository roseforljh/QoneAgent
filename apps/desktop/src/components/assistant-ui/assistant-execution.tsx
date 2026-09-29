import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { ChevronRightIcon } from "lucide-react";
import { useAuiState, useScrollLock } from "@assistant-ui/react";
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
  const allToolsFinished = toolParts.length > 0 && toolParts.every((part) => {
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "success"
      || call?.status === "failed"
      || part.result !== undefined
      || part.isError;
  });
  const executionFinished = runFinished || !messageRunning || (allToolsFinished && finalAnswerStarted);
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
    ? workedDuration ? t("chat.executionWorkedFor", { duration: workedDuration }) : t("chat.executionCompleted", { count: toolParts.length })
    : messageRunning
    ? activeToolIndex >= 0
      ? t("chat.executionRunning", { current: activeToolIndex + 1 })
      : t("chat.executionFinishing")
    : t("chat.executionFinishing");
  const finishing = !executionFinished && activeToolIndex < 0;

  const disclosureKey = JSON.stringify([sessionId, runId, runId ? toolParts[0]?.toolCallId ?? messageId : messageId]);
  const override = useExecutionDisclosureState((state) => state.overrides[disclosureKey]);
  const setCollapsed = useExecutionDisclosureState((state) => state.setCollapsed);
  const collapsed = executionCollapsed(override, finalAnswerStarted, allToolsFinished || !messageRunning, run?.status === "cancelled" || run?.status === "interrupted");
  const visibleOpen = !collapsed;
  const disclosureRef = useRef<HTMLDivElement>(null);
  const lockScroll = useScrollLock(disclosureRef, reduceMotion ? 0 : 240);

  return (
    <div data-slot="assistant-execution" className="q-assistant-execution w-full pb-2">
      <Collapsible ref={disclosureRef} open={visibleOpen} onOpenChange={(nextOpen) => { lockScroll(); setCollapsed(disclosureKey, !nextOpen); }} className="w-full">
        <CollapsibleTrigger
          aria-label={t("chat.executionToggle")}
          className="group/execution-trigger text-foreground/55 hover:text-foreground/90 flex w-full items-center gap-1.5 rounded-md py-1 text-start text-[13.5px] tabular-nums transition-colors outline-none"
        >
          <span>{executionLabel}{finishing && <span className="q-execution-dots" aria-hidden="true"><span>.</span><span>.</span><span>.</span></span>}</span>
          <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]/execution-trigger:rotate-90 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <div className="pt-1"><div className="border-t border-border/60" /></div>
        <AnimatePresence initial={false}>
          {visibleOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -8 }}
              animate={{ height: "auto", opacity: 1, y: 0 }}
              exit={{ height: 0, opacity: 0, y: reduceMotion ? 0 : -8, transition: { duration: reduceMotion ? 0 : 0.15 } }}
              transition={{ duration: reduceMotion ? 0 : 0.24, ease: [0.32, 0.72, 0, 1] }}
              className="overflow-hidden outline-none"
            >
              <div className="flex flex-col gap-1 pt-2">{children}</div>
            </motion.div>
          )}
        </AnimatePresence>
      </Collapsible>
    </div>
  );
};
