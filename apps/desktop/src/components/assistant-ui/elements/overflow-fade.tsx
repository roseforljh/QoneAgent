"use client";

import { useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { observeInlineOverflow } from "../../../lib/inline-overflow";
import { cn } from "../../../lib/utils";

/** Clip only the label, never the adjacent icon, diff counts or disclosure control. */
export function OverflowFade({ children, className, ...props }: ComponentProps<"span">) {
  const viewportRef = useRef<HTMLSpanElement>(null);
  const contentRef = useRef<HTMLSpanElement>(null);
  const [overflow, setOverflow] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content) return;
    return observeInlineOverflow(viewport, content, setOverflow);
  }, []);

  // Flex, not inline-block: an inline formatting context keeps a line-box strut
  // whose baseline pushes the label down, so row icons looked vertically off.
  return <span
    {...props}
    ref={viewportRef}
    data-slot="overflow-fade"
    data-overflow={overflow}
    className={cn("q-inline-overflow-fade flex min-w-0 max-w-full items-center overflow-hidden whitespace-nowrap", className)}
  >
    <span ref={contentRef} className="w-max shrink-0">{children}</span>
  </span>;
}
