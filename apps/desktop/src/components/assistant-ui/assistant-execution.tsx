import { AnimatePresence, motion } from "motion/react";
import { ChevronRightIcon } from "lucide-react";
import { useAuiState } from "@assistant-ui/react";
import { useEffect, useMemo, useRef, useState, type FC, type ReactNode } from "react";
import { Collapsible, CollapsibleTrigger } from "../ui/collapsible";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import type { AssistantPartRange } from "./assistant-part-ranges";

interface AssistantExecutionProps {
  ranges: readonly AssistantPartRange[];
  children: ReactNode;
}

export const AssistantExecution: FC<AssistantExecutionProps> = ({ ranges, children }) => {
  const { t } = useLocale();
  const messageId = useAuiState((state) => state.message.id);
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const parts = useAuiState((state) => state.message.parts);
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
  const lastToolEndIndex = Math.max(
    ...ranges.filter((range): range is Extract<AssistantPartRange, { type: "tools" }> => range.type === "tools")
      .map((range) => range.endIndex),
  );
  const hasSummaryAfterTools = lastToolEndIndex >= 0 && parts.slice(lastToolEndIndex).some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  );
  const allToolsFinished = toolParts.length > 0 && toolParts.every((part) => {
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "success"
      || call?.status === "failed"
      || part.result !== undefined
      || part.isError;
  });
  const executionFinished = runFinished
    || (!messageRunning && allToolsFinished)
    || (allToolsFinished && hasSummaryAfterTools);
  const activeToolIndex = useMemo(() => toolParts.findIndex((part) => {
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "running"
      || call?.status === "waiting"
      || (!call && part.result === undefined && !part.isError);
  }), [toolCallsById, toolParts]);
  const executionLabel = executionFinished
    ? t("chat.executionCompleted", { count: toolParts.length })
    : messageRunning
    ? activeToolIndex >= 0
      ? t("chat.executionRunning", { current: activeToolIndex + 1 })
      : t("chat.executionFinishing")
    : t("chat.executionFinishing");

  const [open, setOpen] = useState(!executionFinished);
  const [manualOpen, setManualOpen] = useState(false);
  const wasExecuting = useRef(!executionFinished);
  const visibleOpen = executionFinished ? manualOpen : open;

  useEffect(() => {
    if (!executionFinished) {
      wasExecuting.current = true;
      setManualOpen(false);
      setOpen(true);
    } else {
      wasExecuting.current = false;
      setManualOpen(false);
      setOpen(false);
    }
  }, [executionFinished]);

  const handleOpenChange = (nextOpen: boolean) => {
    if (executionFinished) setManualOpen(nextOpen);
    else setOpen(nextOpen);
  };

  return (
    <div data-slot="assistant-execution" className="q-assistant-execution w-full pb-2">
      <Collapsible open={visibleOpen} onOpenChange={handleOpenChange} className="w-full">
        <CollapsibleTrigger
          aria-label={t("chat.executionToggle")}
          className="group/execution-trigger text-foreground/55 hover:text-foreground/90 flex w-full items-center gap-1.5 rounded-md py-1 text-start text-[13.5px] tabular-nums transition-colors outline-none"
        >
          <span>{executionLabel}</span>
          <ChevronRightIcon className="size-3.5 shrink-0 opacity-60 transition-transform duration-200 group-data-[state=open]/execution-trigger:rotate-90 motion-reduce:transition-none" />
        </CollapsibleTrigger>
        <AnimatePresence initial={false}>
          {visibleOpen && (
            <motion.div
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
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
