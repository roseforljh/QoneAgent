"use client";

import { CodexChevronRightIcon as ChevronRightIcon, CodexClock3Icon as Clock3Icon, CodexXIcon as XIcon, type ExecutionIcon } from "../execution-icons";

import { useRef, type ReactNode } from "react";
import { useReducedMotion } from "motion/react";
import {
  Collapsible,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { cn } from "../../../lib/utils";
import { MeasuredCollapse } from "./measured-collapse";
import {
  FadeScroll,
  field,
  mono,
  regionViewport,
  ShimmerLabel,
  SwapLabel,
} from "./surfaces";

export interface ToolCallProps {
  icon?: ExecutionIcon;
  label: string;
  activeLabel: string;
  query: string;
  fullTarget?: string;
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
  icon: Icon,
  label,
  activeLabel,
  query,
  fullTarget,
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
  const reduceMotion = useReducedMotion();
  const disclosureRef = useRef<HTMLDivElement>(null);
  return (
    <Collapsible
      ref={disclosureRef}
      data-slot="tool-call"
      data-status={failed ? "failed" : waiting ? "waiting" : pending ? "pending" : running ? "running" : "success"}
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full", className)}
    >
      <CollapsibleTrigger className="group/trigger text-muted-foreground/80 hover:text-foreground inline-flex min-w-0 items-center gap-1.5 py-0.5 text-[13px] font-medium transition-colors outline-none bg-transparent">
        {Icon && <Icon className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover/trigger:opacity-90" />}
        <SwapLabel active={running ? 0 : 1} className="text-start font-medium">
          <ShimmerLabel
            active={running}
            className="relative inline-block leading-none"
          >
            {activeLabel}
          </ShimmerLabel>
          <>{label}</>
        </SwapLabel>
        <span
          title={fullTarget || query}
          className={cn(
            mono,
            "text-muted-foreground/80 min-w-0 max-w-[min(28rem,65vw)] truncate",
          )}
        >
          {query}
        </span>
        {stat && (
          <span className={cn(mono, "flex shrink-0 items-center gap-1 font-mono text-xs tracking-tight")}>
            {stat.added > 0 && <span className="text-emerald-600 dark:text-emerald-400 font-medium">+{stat.added}</span>}
            {stat.removed > 0 && <span className="text-rose-600 dark:text-rose-400 font-medium">−{stat.removed}</span>}
          </span>
        )}
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-40 transition-transform duration-150 ease-out group-hover/trigger:opacity-75 group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />
        {(waiting || failed) && (
          <span className="ms-auto flex w-4 items-center justify-end">
            {waiting && <Clock3Icon className="size-3.5 text-amber-500/80" />}
            {failed && <XIcon className="size-3.5 text-destructive/80" />}
          </span>
        )}
      </CollapsibleTrigger>
      <MeasuredCollapse open={open} className="outline-none">
        <div data-slot="tool-result-panel" className="mt-1.5 overflow-hidden rounded-lg border border-border/40 bg-muted/20 dark:bg-muted/10 shadow-xs">
          <FadeScroll className={cn(regionViewport, "p-2.5")}>{result}</FadeScroll>
        </div>
      </MeasuredCollapse>
    </Collapsible>
  );
}
