"use client";

import { CodexAlertCircleIcon as AlertCircleIcon, CodexChevronRightIcon as ChevronRightIcon, CodexLoader2Icon as Loader2Icon, CodexRotateCwIcon as RotateCwIcon } from "../execution-icons";

import { useCallback, useId, type ComponentProps } from "react";
import { useThreadViewportStore } from "@assistant-ui/react";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../../ui/collapsible";
import { cn } from "../../../lib/utils";
import { detailViewport, FadeScroll, field, mono, paper } from "./surfaces";

export function ToolError({
  name,
  target,
  message,
  attempt,
  maxAttempts,
  retrying = false,
  onRetry,
  onSkip,
  retryLabel = "Retry",
  retryingLabel = "Retrying",
  skipLabel = "Skip",
  open,
  onOpenChange,
  className,
  ...props
}: Omit<
  ComponentProps<"div">,
  | "children"
  | "name"
  | "target"
  | "message"
  | "attempt"
  | "maxAttempts"
  | "retrying"
  | "onRetry"
  | "onSkip"
  | "open"
> & {
  name: string;
  target: string;
  message: string;
  attempt?: number;
  maxAttempts?: number;
  retrying?: boolean;
  onRetry?: () => void;
  onSkip?: () => void;
  retryLabel?: string;
  retryingLabel?: string;
  skipLabel?: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const panelId = useId();
  const threadViewportStore = useThreadViewportStore({ optional: true });
  const getScrollViewport = useCallback(
    () => threadViewportStore?.getState().element.viewport ?? null,
    [threadViewportStore],
  );
  return (
    <Collapsible
      data-slot="tool-error"
      open={open}
      onOpenChange={onOpenChange}
      className={cn(
        paper,
        "flex w-full max-w-sm flex-col rounded-2xl p-3.5",
        className,
      )}
      {...props}
    >
      <CollapsibleTrigger aria-controls={panelId} className="group/trigger flex w-full min-w-0 cursor-pointer items-center gap-2.5 rounded-md bg-transparent text-start outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
        <AlertCircleIcon className="size-3.5 shrink-0 text-foreground/60" />
        <span className={cn(mono, "text-foreground/55 shrink-0")}>{name}</span>
        <span className="text-foreground/80 min-w-0 flex-1 truncate text-sm">
          {target}
        </span>
        {attempt !== undefined && maxAttempts !== undefined && <span className={cn(mono, "text-foreground/30 shrink-0 tabular-nums")}>
          {attempt}/{maxAttempts}
        </span>}
        <ChevronRightIcon className="size-3.5 shrink-0 text-foreground/50 transition-transform duration-150 group-data-[state=open]/trigger:rotate-90 motion-reduce:transition-none" />
      </CollapsibleTrigger>
      <CollapsibleContent id={panelId} className="overflow-hidden data-[state=open]:animate-collapsible-down data-[state=closed]:animate-collapsible-up motion-reduce:animate-none">
        <div className="pt-3">
          <FadeScroll
            className={cn(
              field,
              detailViewport,
              "whitespace-pre-wrap break-words rounded-xl px-3 py-2 font-mono text-xs leading-relaxed text-foreground/60 [overflow-wrap:anywhere]",
            )}
            getScrollViewport={getScrollViewport}
          >
            {message}
          </FadeScroll>
          {(onSkip || onRetry) && <div className="mt-3 flex items-center justify-end gap-2">
            {onSkip && <button
              type="button"
              onClick={onSkip}
              className="text-foreground/45 hover:bg-foreground/[0.06] hover:text-foreground/90 h-7 rounded-full px-2.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none disabled:opacity-30"
            >
              {skipLabel}
            </button>}
            {onRetry && <button
              type="button"
              onClick={onRetry}
              disabled={retrying}
              className="text-foreground/70 hover:bg-foreground/[0.06] hover:text-foreground/95 flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs font-medium transition-[background-color,color,scale] duration-150 active:scale-[0.96] disabled:pointer-events-none"
            >
              {retrying ? (
                <Loader2Icon className="size-3 animate-spin motion-reduce:animate-none" />
              ) : (
                <RotateCwIcon className="size-3" />
              )}
              {retrying ? retryingLabel : retryLabel}
            </button>}
          </div>}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}
