import { useMessageTiming } from "@assistant-ui/react";
import { cn } from "../../lib/utils";
import type { FC } from "react";

const formatTimingMs = (ms: number | undefined): string => {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export const MessageTiming: FC<{ className?: string }> = ({ className }) => {
  const timing = useMessageTiming();
  if (timing?.totalStreamTime === undefined) return null;

  const detail = [
    timing.firstTokenTime !== undefined ? `First token: ${formatTimingMs(timing.firstTokenTime)}` : null,
    `Total: ${formatTimingMs(timing.totalStreamTime)}`,
    timing.tokensPerSecond !== undefined ? `Speed: ${timing.tokensPerSecond.toFixed(1)} tok/s` : null,
    `Chunks: ${timing.totalChunks}`,
  ].filter(Boolean).join("\n");

  return (
    <button
      type="button"
      data-slot="message-timing-trigger"
      aria-label="Message timing"
      title={detail}
      className={cn("text-muted-foreground hover:bg-accent hover:text-accent-foreground flex items-center rounded-md p-1 font-mono text-xs tabular-nums transition-colors", className)}
    >
      {formatTimingMs(timing.totalStreamTime)}
    </button>
  );
};
