"use client";

import { type ComponentProps, useMemo } from "react";
import { cn } from "../../../lib/utils";
import { take } from "../utils/range";

export interface Segment {
  text: string;
  mono?: boolean;
}

export function StreamingText({
  segments,
  count,
  streaming,
  className,
  ...props
}: Omit<
  ComponentProps<"p">,
  "children" | "segments" | "count" | "streaming"
> & {
  segments: Segment[];
  count: number;
  streaming: boolean;
}) {
  const words = useMemo(
    () =>
      segments.flatMap((segment) =>
        segment.text
          .split(" ")
          .map((word) => ({ word, mono: segment.mono ?? false })),
      ),
    [segments],
  );
  const shown = take(words, count);
  const text = shown.map(({ word }) => word).join(" ");

  return (
    <p
      data-slot="streaming-text"
      className={cn(
        "min-h-[8.5rem] max-w-sm text-sm leading-relaxed text-pretty",
        className,
      )}
      {...props}
    >
      <span
        className={cn(
          "aui-streaming-copy",
          streaming && "shimmer shimmer-speed-150 shimmer-spread-200 shimmer-repeat-delay-0 motion-reduce:animate-none",
        )}
      >
        {text}
      </span>
      {streaming && shown.length > 0 && (
        <span
          aria-hidden
          className="-mb-0.5 ml-0.5 inline-block h-4 w-0.5 animate-pulse rounded-full bg-foreground/35 motion-reduce:animate-none"
        />
      )}
    </p>
  );
}
