"use client";

import { useEffect, useLayoutEffect, useRef, type ComponentProps } from "react";
import { cn } from "../../../lib/utils";
import { bindScrollRegion } from "../../../lib/scroll-region";

export interface FadeScrollProps extends ComponentProps<"div"> {
  /** Follow streamed content until the user scrolls away from the bottom. */
  autoScrollToBottom?: boolean;
}

const noopEdges = () => {};

/** 滚动渐隐由全局 scroll-fade.css 统一提供，本组件仅保留流式自动跟随底部能力。 */
export function FadeScroll({
  className, children, autoScrollToBottom = false, ...props
}: FadeScrollProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const optionsRef = useRef({ autoScrollToBottom });

  useLayoutEffect(() => {
    optionsRef.current = { autoScrollToBottom };
  }, [autoScrollToBottom]);

  useEffect(() => {
    if (!autoScrollToBottom) return;
    const element = scrollRef.current;
    const content = contentRef.current;
    if (!element || !content) return;
    return bindScrollRegion(element, content, {
      autoFollow: () => optionsRef.current.autoScrollToBottom,
      onEdgesChange: noopEdges,
    });
  }, [autoScrollToBottom]);

  return <div
    ref={scrollRef}
    className={cn("overflow-y-auto", className)}
    {...props}
    data-scroll-region=""
  >
    <div ref={contentRef}>{children}</div>
  </div>;
}
