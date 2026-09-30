import { useLocale } from "../../localization";
import { useMessageTiming } from "@assistant-ui/react";
import { cn } from "../../lib/utils";
import type { FC } from "react";

const formatTimingMs = (ms: number | undefined): string => {
  if (ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
};

export const MessageTiming: FC<{ className?: string }> = ({ className }) => {
  const { t } = useLocale();
  const timing = useMessageTiming();
  if (timing?.totalStreamTime === undefined) return null;

  const detail = [
    timing.firstTokenTime !== undefined ? t("timing.firstToken", { value: formatTimingMs(timing.firstTokenTime) }) : null,
    t("timing.total", { value: formatTimingMs(timing.totalStreamTime) }),
    timing.tokensPerSecond !== undefined ? t("timing.speed", { value: timing.tokensPerSecond.toFixed(1) }) : null,
    t("timing.chunks", { value: timing.totalChunks }),
  ].filter(Boolean).join("\n");

  return (
    <button
      type="button"
      data-slot="message-timing-trigger"
      aria-label={t("timing.title")}
      title={detail}
      className={cn("text-muted-foreground hover:bg-accent hover:text-accent-foreground flex items-center rounded-md p-1 font-mono text-xs tabular-nums transition-colors", className)}
    >
      {formatTimingMs(timing.totalStreamTime)}
    </button>
  );
};
