import { useEffect, useState, type FC } from "react";
import { useLocale } from "../../localization";
import { CodexTextSelectIcon } from "../ui/CodexIcon";
import { ShimmerLabel } from "./elements/surfaces";

const DELAY_NOTICE_MS = 10_000;

export const ContextCompactionMarker: FC<{ status: "running" | "completed" | "interrupted"; source: "manual" | "automatic"; startedAt: number }> = ({ status, source, startedAt }) => {
  const { t } = useLocale();
  const running = status === "running";
  const [delayed, setDelayed] = useState(() => Date.now() - startedAt >= DELAY_NOTICE_MS);

  useEffect(() => {
    if (!running) return;
    const remaining = startedAt + DELAY_NOTICE_MS - Date.now();
    if (remaining <= 0) { setDelayed(true); return; }
    setDelayed(false);
    const timer = window.setTimeout(() => setDelayed(true), remaining);
    return () => window.clearTimeout(timer);
  }, [running, startedAt]);

  return (
    <div
      data-slot="context-compaction"
      className="mx-auto flex w-full q-thread-content items-center gap-2 py-1 text-sm leading-5 text-muted-foreground"
      role={running ? "status" : undefined}
      aria-live={running ? "polite" : undefined}
    >
      <CodexTextSelectIcon className="size-4 shrink-0 opacity-70" />
      <ShimmerLabel active={running}>
        {t(running ? delayed ? "composer.compactingDelayed" : "composer.compacting" : status === "interrupted" ? "composer.compactionInterrupted" : source === "automatic" ? "composer.autoCompacted" : "composer.compacted")}
      </ShimmerLabel>
    </div>
  );
};
