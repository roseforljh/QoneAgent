"use client";

import { CodexClock3Icon as Clock3Icon, type ExecutionIcon } from "../execution-icons";

import { useId, useRef, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { cn } from "../../../lib/utils";
import { MeasuredCollapse } from "./measured-collapse";
import {
  FadeScroll,
  detailViewport,
  mono,
  regionViewport,
  ShimmerLabel,
  SwapLabel,
} from "./surfaces";
import { OverflowFade } from "./overflow-fade";

export interface ToolCallProps {
  icon?: ExecutionIcon;
  label: string;
  activeLabel: string;
  query: string;
  fullTarget?: string;
  targetAction?: { label: string; onClick: () => void; ariaLabel: string };
  header?: (panelId: string) => ReactNode;
  stat?: { added: number; removed: number };
  /** Kept for callers that still have the serialized arguments; it is not rendered. */
  request?: string;
  result: ReactNode;
  resultHasOwnFrame?: boolean;
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
  targetAction,
  header,
  stat,
  result,
  resultHasOwnFrame = false,
  running,
  pending = false,
  waiting = false,
  failed = false,
  open,
  onOpenChange,
  className,
}: ToolCallProps) {
  const disclosureRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  const target = fullTarget || query;
  const title = [running ? activeLabel : label, targetAction ? undefined : target].filter(Boolean).join(" ");
  return (
    <Collapsible
      ref={disclosureRef}
      data-slot="tool-call"
      data-status={failed ? "failed" : waiting ? "waiting" : pending ? "pending" : running ? "running" : "success"}
      open={open}
      onOpenChange={onOpenChange}
      className={cn("min-w-0 w-full max-w-full", className)}
    >
      {header ? header(panelId) : <div className="flex min-w-0 max-w-full items-center gap-1.5">
        <CollapsibleTrigger aria-controls={panelId} title={title} className="group/trigger text-foreground/60 hover:text-foreground inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md py-0.5 text-[13px] font-medium transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring bg-transparent">
          {Icon && <Icon className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover/trigger:opacity-90" />}
          <OverflowFade title={target || undefined}>
            <span className="inline-flex items-center gap-1.5">
              <SwapLabel active={running ? 0 : 1} className="shrink-0 text-start font-medium">
                <ShimmerLabel active={running} className="relative inline-block leading-none">{activeLabel}</ShimmerLabel>
                <>{label}</>
              </SwapLabel>
              {!targetAction && query && <ShimmerLabel active={running} className={cn(mono, "text-current")}>{query}</ShimmerLabel>}
            </span>
          </OverflowFade>
          {stat && !targetAction && (
            <span className={cn(mono, "flex shrink-0 items-center gap-1 font-mono text-xs tracking-tight")}>
              {stat.added > 0 && <span className="text-emerald-600 dark:text-emerald-400 font-medium">+{stat.added}</span>}
              {stat.removed > 0 && <span className="text-rose-600 dark:text-rose-400 font-medium">−{stat.removed}</span>}
            </span>
          )}
          {waiting && (
            <span className="ms-auto flex w-4 shrink-0 items-center justify-end">
              <Clock3Icon className="size-3.5 text-amber-500/80" />
            </span>
          )}
        </CollapsibleTrigger>
        {targetAction && <button type="button" data-slot="tool-target-link" onClick={targetAction.onClick} aria-label={targetAction.ariaLabel} title={fullTarget || targetAction.label} className={cn(mono, "min-w-0 truncate rounded-sm text-[13px] text-foreground/70 underline decoration-dotted decoration-foreground/30 underline-offset-2 hover:text-foreground hover:decoration-current focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring")}><ShimmerLabel active={running} className="inline">{targetAction.label}</ShimmerLabel></button>}
        {targetAction && stat && <span className={cn(mono, "flex shrink-0 items-center gap-1 text-xs tracking-tight")}>
          {stat.added > 0 && <span className="text-emerald-600 dark:text-emerald-400 font-medium">+{stat.added}</span>}
          {stat.removed > 0 && <span className="text-rose-600 dark:text-rose-400 font-medium">−{stat.removed}</span>}
        </span>}
      </div>}
      <MeasuredCollapse id={panelId} open={open} className="outline-none">
        {open && <div data-slot="tool-result-panel" className={cn("mt-1.5", !resultHasOwnFrame && "overflow-hidden rounded-lg border border-border/40 bg-muted/20 dark:bg-muted/10 shadow-xs")}>
          <FadeScroll
            className={cn(failed ? detailViewport : regionViewport, resultHasOwnFrame ? "pe-2" : "p-2.5")}
            autoScrollToBottom={running}
          >{result}</FadeScroll>
        </div>}
      </MeasuredCollapse>
    </Collapsible>
  );
}
