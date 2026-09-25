"use client";

import type { ComponentProps } from "react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { cn } from "../../../lib/utils";

export const paper = "bg-background border border-border/60 dark:bg-popover";

export const floating = "bg-background border border-border/60 dark:bg-popover";

export const field = "bg-foreground/[0.04] dark:bg-foreground/[0.06]";

export const fieldInteractive =
  "bg-foreground/[0.04] transition-colors hover:bg-foreground/[0.07] dark:bg-foreground/[0.06] dark:hover:bg-foreground/[0.09]";

export const pressable =
  "transition-transform duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] active:scale-[0.96] motion-reduce:transition-none";

export const ghostButton =
  "flex items-center justify-center rounded-full text-foreground/45 outline-none transition-[background-color,color,scale] duration-150 hover:bg-foreground/[0.06] hover:text-foreground/90 active:scale-[0.96] focus-visible:ring-1 focus-visible:ring-foreground/20 motion-reduce:transition-none dark:hover:bg-foreground/[0.09]";

export const inkButton =
  "bg-foreground text-background transition-[opacity,scale] duration-150 ease-[cubic-bezier(0.23,1,0.32,1)] hover:opacity-90 active:scale-[0.96] motion-reduce:transition-none";

export const iconSwap =
  "[grid-area:1/1] transition-[opacity,scale,filter] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:transition-none";

export const iconSwapIn = "scale-100 opacity-100 blur-none";

export const iconSwapOut = "scale-[0.25] opacity-0 blur-[4px]";

export const labelSwap =
  "col-start-1 row-start-1 flex w-max items-center gap-1.5 leading-none transition-[opacity,filter] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none";

export const labelSwapIn = "opacity-100 blur-none";

export const labelSwapOut =
  "pointer-events-none select-none opacity-0 blur-[2px]";

export const collapsePanel =
  "overflow-hidden";

// Shared detail viewports let long results scroll without reserving empty
// space for short responses.
export const detailViewport =
  "min-h-0 max-h-[min(16rem,38dvh)] overflow-auto";

export const terminalViewport =
  "min-h-0 max-h-[min(18rem,40dvh)] overflow-auto";

// Expandable regions share one cap: content under it flows naturally, taller
// content scrolls inside and fades at whichever edge is clipped.
export const regionViewport = "max-h-[min(22rem,60dvh)]";

export function FadeScroll({ className, children, ...props }: ComponentProps<"div">) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [fadeTop, setFadeTop] = useState(false);
  const [fadeBottom, setFadeBottom] = useState(false);

  useEffect(() => {
    const scrollEl = scrollRef.current;
    const contentEl = contentRef.current;
    if (!scrollEl || !contentEl) return undefined;
    const update = () => {
      const remaining = scrollEl.scrollHeight - scrollEl.clientHeight;
      setFadeTop(scrollEl.scrollTop > 2);
      setFadeBottom(remaining - scrollEl.scrollTop > 2);
    };
    update();
    scrollEl.addEventListener("scroll", update, { passive: true });
    const observer = new ResizeObserver(update);
    observer.observe(scrollEl);
    observer.observe(contentEl);
    return () => {
      scrollEl.removeEventListener("scroll", update);
      observer.disconnect();
    };
  }, []);

  const maskImage = fadeTop || fadeBottom
    ? `linear-gradient(to bottom, transparent, black ${fadeTop ? "1.25rem" : "0rem"}, black calc(100% - ${fadeBottom ? "1.25rem" : "0rem"}), transparent)`
    : undefined;

  return (
    <div
      ref={scrollRef}
      className={cn("overflow-y-auto", className)}
      style={maskImage ? { maskImage, WebkitMaskImage: maskImage } : undefined}
      {...props}
    >
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

export const live = "text-blue-500 dark:text-blue-400";

export const mono = "font-mono text-[11px] tracking-tight";

export function ShimmerLabel({
  active = true,
  className,
  children,
  ...props
}: ComponentProps<"span"> & { active?: boolean }) {
  return (
    <span className={cn("relative inline-block", className)} {...props}>
      {children}
      {active && (
        <span aria-hidden className="q-shine-text motion-reduce:hidden">
          {children}
        </span>
      )}
    </span>
  );
}

export function EllipsisDots() {
  return (
    <span aria-hidden className="q-ellipsis-dots">
      <span />
      <span />
      <span />
    </span>
  );
}

/**
 * Scroll region for content that keeps its own whitespace. `whitespace-pre` in
 * a bounded box clips a long line with no way to reach it, so the rows scroll
 * instead.
 *
 * `codeSurface` wraps all the rows as one block, and the rows are its children.
 * It cannot go on each row: `min-width: 100%` resolves against the scroll
 * container's visible width rather than its scroll width, so a per-row width
 * leaves every row except the longest ending its background at the fold.
 */
export const codeScroll = "overflow-x-auto";

export const codeSurface = "w-max min-w-full";

export function SwapLabel({
  active,
  children,
  className,
}: {
  active: 0 | 1;
  children: [React.ReactNode, React.ReactNode];
  className?: string;
}) {
  const layers = [useRef<HTMLSpanElement>(null), useRef<HTMLSpanElement>(null)];
  const [width, setWidth] = useState<number | null>(null);

  useLayoutEffect(() => {
    const target = layers[active]?.current;
    if (!target) return undefined;
    const measure = () =>
      setWidth(Math.ceil(target.getBoundingClientRect().width));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(target);
    return () => observer.disconnect();
  }, [active]);

  return (
    <span
      style={width === null ? undefined : { width }}
      className={cn(
        "grid overflow-x-clip transition-[width] duration-300 ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none",
        className,
      )}
    >
      {children.map((layer, index) => (
        <span
          key={index}
          ref={layers[index]}
          aria-hidden={active !== index}
          className={cn(
            labelSwap,
            active === index ? labelSwapIn : labelSwapOut,
          )}
        >
          {layer}
        </span>
      ))}
    </span>
  );
}
