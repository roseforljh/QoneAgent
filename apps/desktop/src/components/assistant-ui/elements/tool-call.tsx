"use client";

import { CheckIcon, ChevronRightIcon, Clock3Icon, XIcon } from "lucide-react";
import type { ReactNode } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Collapsible,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { cn } from "../../../lib/utils";
import {
  FadeScroll,
  field,
  mono,
  regionViewport,
  ShimmerLabel,
  SwapLabel,
} from "./surfaces";

export interface ToolCallProps {
  label: string;
  activeLabel: string;
  query: string;
  stat?: { added: number; removed: number };
  /** Kept for callers that still have the serialized arguments; it is not rendered. */
  request?: string;
  result: ReactNode;
  running: boolean;
  pending?: boolean;
  waiting?: boolean;
  failed?: boolean;
  requestLabel?: string;
  resultLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  className?: string;
}

export function ToolCall({
  label,
  activeLabel,
  query,
  stat,
  result,
  running,
  pending = false,
  waiting = false,
  failed = false,
  open,
  onOpenChange,
  className,
}: ToolCallProps) {
  return (
    <Collapsible
      data-slot="tool-call"
      data-status={failed ? "failed" : waiting ? "waiting" : pending ? "pending" : running ? "running" : "success"}
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger className="group/trigger text-foreground/55 hover:text-foreground/90 bg-background sticky top-0 z-10 -mx-1.5 flex w-[calc(100%+0.75rem)] min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-[13.5px] transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring">
        <SwapLabel active={running ? 0 : 1} className="text-start">
          <ShimmerLabel
            active={running}
            className="relative inline-block leading-none"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        <span
          className={cn(
            mono,
            "bg-foreground/[0.06] text-foreground/70 min-w-0 max-w-[min(24rem,55vw)] truncate rounded-md px-1.5 py-0.5",
          )}
        >
          {query}
        </span>
        {stat && (
          <span className={cn(mono, "bg-foreground/[0.06] flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5")}>
            {stat.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{stat.added}</span>}
            {stat.removed > 0 && <span className="text-red-600 dark:text-red-400">−{stat.removed}</span>}
          </span>
        )}
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-0 transition duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover/trigger:opacity-60 group-focus-visible/trigger:opacity-60 group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />
        <span className="ms-auto flex w-4 items-center justify-end">
          {waiting && <Clock3Icon className="size-3.5 text-amber-500" />}
          {failed && <XIcon className="size-3.5 text-red-500" />}
          {!running && !waiting && !pending && !failed && (
            <CheckIcon className="fade-in zoom-in-90 animate-in size-3.5 text-emerald-500 duration-200" />
          )}
        </span>
      </CollapsibleTrigger>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.24, ease: [0.32, 0.72, 0, 1] }}
            className="overflow-hidden outline-none"
          >
            <div data-slot="tool-result-panel" className={cn(field, "mt-2 overflow-hidden rounded-2xl")}>
              <FadeScroll className={cn(regionViewport, "p-2.5")}>{result}</FadeScroll>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Collapsible>
  );
}
