"use client";

import { ChevronDownIcon } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import {
  Collapsible,
  CollapsibleTrigger,
} from "../../ui/collapsible";
import { cn } from "../../../lib/utils";
import { FadeScroll, fieldInteractive, mono, paper, regionViewport } from "./surfaces";

export interface Source {
  domain: string;
  title: string;
  url?: string;
}

export interface SourcesProps {
  sources: readonly Source[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSource?: (url: string) => void;
  className?: string;
  label?: string;
}

export function Sources({
  sources,
  open,
  onOpenChange,
  onOpenSource,
  className,
  label = "Sources",
}: SourcesProps) {
  return (
    <Collapsible
      data-slot="sources"
      open={open}
      onOpenChange={onOpenChange}
      className={cn("w-full max-w-sm", className)}
    >
      <CollapsibleTrigger
        className={cn(
          fieldInteractive,
          "group/trigger text-foreground/60 hover:text-foreground/90 inline-flex w-fit items-center gap-1.5 rounded-full px-3.5 py-2 text-xs outline-none",
        )}
      >
        <span>{label}</span>
        <span className={cn(mono, "text-foreground/35 tabular-nums")}>
          {sources.length}
        </span>
        <ChevronDownIcon className="size-3 opacity-60 transition-transform duration-200 ease-[cubic-bezier(0.32,0.72,0,1)] group-data-open/trigger:rotate-180 group-data-panel-open/trigger:rotate-180 motion-reduce:transition-none" />
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
        <FadeScroll className={cn(regionViewport, "pt-2.5")}>
        <div className="grid grid-cols-2 gap-2">
          {sources.map((source) => (
            <a
              key={source.url ?? source.domain}
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={source.url && onOpenSource ? (event) => { event.preventDefault(); onOpenSource(source.url!); } : undefined}
              className={cn(
                paper,
                "flex min-w-0 flex-col gap-1.5 rounded-2xl p-3 transition-transform hover:-translate-y-px",
              )}
            >
              <div className="flex items-center gap-1.5">
                <span className="bg-foreground/[0.06] text-foreground/45 flex size-4 shrink-0 items-center justify-center rounded text-[9px] font-medium">
                  {source.domain.charAt(0).toUpperCase()}
                </span>
                <span className={cn(mono, "text-foreground/40 truncate")}>
                  {source.domain}
                </span>
              </div>
              <span className="text-foreground/90 line-clamp-2 text-[13px] leading-snug font-medium">
                {source.title}
              </span>
            </a>
          ))}
        </div>
        </FadeScroll>
          </motion.div>
        )}
      </AnimatePresence>
    </Collapsible>
  );
}
