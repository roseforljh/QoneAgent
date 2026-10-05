"use client";

import { CodexChevronRightIcon as ChevronRightIcon, type ExecutionIcon } from "../execution-icons";

import { useId, useRef, type ReactNode } from "react";
import {
  Collapsible,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { cn } from "../../../lib/utils";
import { MeasuredCollapse } from "./measured-collapse";
import { FadeScroll, regionViewport, ShimmerLabel, SwapLabel } from "./surfaces";
import { take } from "../utils/range";
import { OverflowFade } from "./overflow-fade";
import type { ToolActivityCategory } from "../tool-activity-category";

export interface TimelineStep {
  id?: string;
  verb: string;
  chip: string;
  icon: ExecutionIcon;
  done?: boolean;
  category?: ToolActivityCategory;
}

export interface TimelineStat {
  file: string;
  added?: number;
  removed?: number;
}

export interface ToolTimelineProps {
  steps: readonly TimelineStep[];
  visibleSteps: number;
  streaming: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  restingLabel: string;
  activeLabel: string;
  fullSummary?: string;
  fullActiveLabel?: string;
  headerIcon?: ExecutionIcon;
  canExpand?: boolean;
  failureLabel?: string;
  stats: TimelineStat[];
  renderStep?: (step: TimelineStep, index: number) => ReactNode;
  children?: ReactNode;
  className?: string;
}

export function ToolTimelineRow({ step, active = false, children }: { step: TimelineStep; active?: boolean; children?: ReactNode }) {
  const Icon = step.icon;
  return <div className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-foreground/55 flex min-w-0 items-start gap-2 text-[13.5px] duration-300">
    <Icon className="mt-1.5 size-3.5 shrink-0 transition-colors duration-300 text-foreground/55" />
    {children ?? <>
      <ShimmerLabel active={active} className="relative inline-block leading-none">{step.verb}</ShimmerLabel>
      <span className="bg-foreground/[0.06] text-foreground/70 rounded-md px-1.5 py-0.5 font-mono text-xs">{step.chip}</span>
    </>}
  </div>;
}

export function ToolTimeline({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  fullSummary,
  fullActiveLabel,
  headerIcon: HeaderIcon,
  canExpand = true,
  failureLabel,
  stats,
  renderStep,
  children,
  className,
}: ToolTimelineProps) {
  const disclosureRef = useRef<HTMLDivElement>(null);
  const panelId = useId();
  return (
    <Collapsible
      ref={disclosureRef}
      data-slot="tool-timeline"
      data-status={failureLabel ? "failed" : undefined}
      open={open && canExpand}
      onOpenChange={onOpenChange}
      className={cn("min-w-0 w-full max-w-full", className)}
    >
      <CollapsibleTrigger
        disabled={!canExpand}
        aria-controls={panelId}
        title={streaming ? fullActiveLabel ?? activeLabel : fullSummary ?? restingLabel}
        className="group/trigger text-foreground/60 hover:text-foreground inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md py-0.5 text-[13px] font-normal transition-colors outline-none focus-visible:ring-2 focus-visible:ring-ring bg-transparent"
      >
        {HeaderIcon && <HeaderIcon className="size-3.5 shrink-0 opacity-60 transition-opacity group-hover/trigger:opacity-90" />}
        <OverflowFade>
          <SwapLabel
            active={streaming ? 0 : 1}
            className="text-start tabular-nums"
          >
            <ShimmerLabel
              active={streaming}
              className="relative inline-block leading-none"
            >
              {activeLabel}
            </ShimmerLabel>
            <>{restingLabel}</>
          </SwapLabel>
        </OverflowFade>
        {failureLabel && <span className="sr-only" aria-label={failureLabel}>{failureLabel}</span>}
        {canExpand && <ChevronRightIcon data-slot="tool-disclosure-chevron" className="size-3.5 shrink-0 opacity-0 transition-[transform,opacity] duration-150 ease-out group-hover/trigger:opacity-75 group-focus-visible/trigger:opacity-100 group-data-[state=open]/trigger:opacity-100 group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />}
      </CollapsibleTrigger>
      <MeasuredCollapse id={panelId} open={open && canExpand} className="outline-none">
        <FadeScroll className={cn(regionViewport, "overflow-x-hidden")} autoScrollToBottom={streaming}>
          <div className="flex flex-col gap-2 ps-3 pt-2">
              {children ?? take(steps, visibleSteps).map((step, index, shown) => <ToolTimelineRow key={step.id ?? step.chip} step={step} active={streaming && index === shown.length - 1}>
                {renderStep?.(step, index)}
              </ToolTimelineRow>)}
              {stats.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {stats.map((stat) => (
                    <span
                      key={stat.file}
                      className="bg-foreground/[0.06] text-foreground/70 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-xs"
                    >
                      <span>{stat.file}</span>
                      {stat.added !== undefined && (
                        <span className="text-foreground/60">
                          +{stat.added}
                        </span>
                      )}
                      {stat.removed !== undefined && (
                        <span className="text-foreground/60">
                          −{stat.removed}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
          </div>
        </FadeScroll>
      </MeasuredCollapse>
    </Collapsible>
  );
}
