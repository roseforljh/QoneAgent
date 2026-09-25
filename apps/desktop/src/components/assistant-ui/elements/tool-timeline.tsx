"use client";

import type { ReactNode } from "react";
import { ChevronRightIcon, type LucideIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  Collapsible,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { cn } from "../../../lib/utils";
import { FadeScroll, regionViewport, ShimmerLabel, SwapLabel } from "./surfaces";
import { take } from "../utils/range";

export interface TimelineStep {
  id?: string;
  verb: string;
  chip: string;
  icon: LucideIcon;
  /** Icon color once the operation completes. */
  tint?: string;
  done?: boolean;
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
  headerIcon?: LucideIcon;
  headerTint?: string;
  headerStat?: { added: number; removed: number };
  stats: TimelineStat[];
  renderStep?: (step: TimelineStep, index: number) => ReactNode;
  className?: string;
}

export function ToolTimeline({
  steps,
  visibleSteps,
  streaming,
  open,
  onOpenChange,
  restingLabel,
  activeLabel,
  headerIcon: HeaderIcon,
  headerTint,
  headerStat,
  stats,
  renderStep,
  className,
}: ToolTimelineProps) {
  return (
    <Collapsible
      data-slot="tool-timeline"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger className="group/trigger text-foreground/55 hover:text-foreground/90 bg-background sticky top-0 z-10 -mx-1.5 flex w-[calc(100%+0.75rem)] items-center gap-1.5 rounded-md px-1.5 py-1 text-[13.5px] transition-colors outline-none">
        {HeaderIcon && <HeaderIcon className={cn("size-3.5 shrink-0 transition-colors duration-300", headerTint ?? "opacity-60")} />}
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
        {headerStat && (headerStat.added > 0 || headerStat.removed > 0) && (
          <span className="bg-foreground/[0.06] flex shrink-0 items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px] tracking-tight">
            {headerStat.added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{headerStat.added}</span>}
            {headerStat.removed > 0 && <span className="text-red-600 dark:text-red-400">−{headerStat.removed}</span>}
          </span>
        )}
        <ChevronRightIcon className="size-3.5 shrink-0 opacity-0 transition duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-hover/trigger:opacity-60 group-focus-visible/trigger:opacity-60 group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />
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
            <FadeScroll className={regionViewport}>
            <div className="flex flex-col gap-2.5 ps-4 pt-2.5">
              {take(steps, visibleSteps).map((step, index, shown) => {
                const Icon = step.icon;
                const active = streaming && index === shown.length - 1;

                return (
                  <div
                    key={step.id ?? step.chip}
                    className="fade-in slide-in-from-bottom-1 animate-in fill-mode-both text-foreground/55 flex min-w-0 items-start gap-2 text-[13.5px] duration-300"
                  >
                    <Icon className={cn("mt-1.5 size-3.5 shrink-0 transition-colors duration-300", step.done && step.tint ? step.tint : "text-foreground/35")} />
                    {renderStep ? renderStep(step, index) : <>
                      <ShimmerLabel
                        active={active}
                        className="relative inline-block leading-none"
                      >
                        {step.verb}
                      </ShimmerLabel>
                      <span className="bg-foreground/[0.06] text-foreground/70 rounded-md px-1.5 py-0.5 font-mono text-[11px]">
                        {step.chip}
                      </span>
                    </>}
                  </div>
                );
              })}
              {stats.length > 0 && (
                <div className="flex flex-wrap gap-1.5 pt-1">
                  {stats.map((stat) => (
                    <span
                      key={stat.file}
                      className="bg-foreground/[0.06] text-foreground/70 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 font-mono text-[11px]"
                    >
                      <span>{stat.file}</span>
                      {stat.added !== undefined && (
                        <span className="text-emerald-600 dark:text-emerald-400">
                          +{stat.added}
                        </span>
                      )}
                      {stat.removed !== undefined && (
                        <span className="text-red-600 dark:text-red-400">
                          −{stat.removed}
                        </span>
                      )}
                    </span>
                  ))}
                </div>
              )}
            </div>
            </FadeScroll>
          </motion.div>
        )}
      </AnimatePresence>
    </Collapsible>
  );
}
