"use client";

import type { ComponentProps } from "react";
import { PreviewCard } from "@base-ui/react/preview-card";
import { cn } from "../../../lib/utils";
import { floating, mono } from "./surfaces";

export interface Source {
  domain: string;
  title?: string;
  snippet?: string;
  url?: string;
  label?: string;
}

interface CitationProps {
  index: number;
  source: Source;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onOpenSource?: (url: string) => void;
}

function Citation({ index, source, open, onOpenChange, onOpenSource }: CitationProps) {
  return (
    <PreviewCard.Root open={open} onOpenChange={onOpenChange}>
      <PreviewCard.Trigger
        delay={0}
        render={<button type="button" aria-label={`Citation ${source.label ?? index + 1}: ${source.domain}`} />}
        className={cn(
          "mx-0.5 inline-flex h-4 min-w-4 translate-y-[-2px] cursor-default items-center justify-center rounded-[5px] px-1 align-middle font-mono text-[10px] font-medium tabular-nums transition-colors",
          open
            ? "bg-foreground text-background"
            : "bg-foreground/[0.06] text-foreground/45 hover:text-foreground/90",
        )}
      >
        {source.label ?? index + 1}
      </PreviewCard.Trigger>
      <PreviewCard.Portal>
        <PreviewCard.Positioner side="top" sideOffset={8}>
          <PreviewCard.Popup
            className={cn(
              floating,
              "z-50 w-64 origin-(--transform-origin) rounded-2xl p-3.5 outline-none",
              "transition-[opacity,scale] duration-200 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
              "data-[starting-style]:scale-[0.97] data-[starting-style]:opacity-0",
              "data-[ending-style]:scale-[0.97] data-[ending-style]:opacity-0",
            )}
          >
            <div className="flex items-center gap-1.5">
              <span className="bg-foreground/[0.06] text-foreground/45 flex size-4 items-center justify-center rounded text-[9px] font-medium">
                {source.domain[0]?.toUpperCase()}
              </span>
              <span className={cn(mono, "text-foreground/40")}>
                {source.domain}
              </span>
            </div>
            {source.title && <p className="mt-2 text-[13px] leading-snug font-medium">{source.title}</p>}
            {source.snippet && <p className="text-foreground/50 mt-1 text-[13px] leading-relaxed">{source.snippet}</p>}
            {source.url && <a
              href={source.url}
              target="_blank"
              rel="noopener noreferrer"
              onClick={onOpenSource ? (event) => { event.preventDefault(); onOpenSource(source.url!); } : undefined}
              className="text-foreground/65 hover:text-foreground mt-2 block truncate text-[11px] underline underline-offset-2"
            >{source.url}</a>}
          </PreviewCard.Popup>
        </PreviewCard.Positioner>
      </PreviewCard.Portal>
    </PreviewCard.Root>
  );
}

export interface InlineCitationProps extends Omit<
  ComponentProps<"span">,
  "children"
> {
  sources: readonly Source[];
  openIndex: number | null;
  onOpenIndexChange: (index: number | null) => void;
  onOpenSource?: (url: string) => void;
}

export function InlineCitation({
  sources,
  openIndex,
  onOpenIndexChange,
  onOpenSource,
  className,
  ...props
}: InlineCitationProps) {
  return (
    <span
      data-slot="inline-citation"
      className={cn("inline-flex align-middle", className)}

      {...props}
    >
      {sources.map((source, index) => (
        <Citation
          key={`${source.url ?? source.domain}:${index}`}
          index={index}
          source={source}
          open={openIndex === index}
          onOpenChange={(open) => onOpenIndexChange(open ? index : null)}
          onOpenSource={onOpenSource}
        />
      ))}
    </span>
  );
}
