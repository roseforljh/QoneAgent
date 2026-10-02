"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ComponentProps } from "react";
import { cn } from "../../../lib/utils";
import { bindScrollRegion } from "../../../lib/scroll-region";

export interface FadeScrollProps extends ComponentProps<"div"> {
  /** Follow streamed content until the user scrolls away from the bottom. */
  autoScrollToBottom?: boolean;
}

export function FadeScroll({
  className, children, autoScrollToBottom = false, style, ...props
}: FadeScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef({ autoScrollToBottom });
  const [edges, setEdges] = useState({ top: false, bottom: false });

  useLayoutEffect(() => {
    optionsRef.current = { autoScrollToBottom };
  }, [autoScrollToBottom]);

  useEffect(() => {
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    return bindScrollRegion(element, content, {
      autoFollow: () => optionsRef.current.autoScrollToBottom,
      onEdgesChange: (next) => setEdges((current) =>
        current.top === next.top && current.bottom === next.bottom ? current : next),
    });
  }, []);

  const maskImage = edges.top || edges.bottom
    ? `linear-gradient(to bottom, transparent, black ${edges.top ? "1.25rem" : "0rem"}, black calc(100% - ${edges.bottom ? "1.25rem" : "0rem"}), transparent)`
    : undefined;

  return <div
    ref={scrollRef}
    className={cn("overflow-y-auto", className)}
    style={{ ...(maskImage ? { maskImage, WebkitMaskImage: maskImage } : {}), ...style }}
    {...props}
    data-scroll-region=""
  >
    <div ref={contentRef}>{children}</div>
  </div>;
}
