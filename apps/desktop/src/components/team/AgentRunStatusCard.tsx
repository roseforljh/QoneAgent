import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  Laptop,
  Pause,
  Play,
  Sparkles,
  Square,
  XCircle,
} from "lucide-react";
import type { ServerInfo } from "@qone/protocol";
import type { TeamBot, TeamRunCard, TeamRunStep } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { CodexServerIcon } from "../ui/CodexIcon";
import { SubagentLogo } from "../settings/subagent-logo";
import { MorphingSpinner } from "../assistant-ui/morphing-spinner";

interface AgentRunStatusCardProps {
  run: TeamRunCard;
  botsById: ReadonlyMap<string, TeamBot>;
  serversById: ReadonlyMap<string, ServerInfo>;
  compact?: boolean;
  defaultOpen?: boolean;
  onAction: (action: "pause" | "resume" | "cancel") => void;
}

function formatElapsed(startedAt: number, endAt: number): string {
  const seconds = Math.max(0, Math.floor((endAt - startedAt) / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return `${minutes}m ${String(rest).padStart(2, "0")}s`;
}

function StepStatusIcon({ status }: { status: TeamRunStep["status"] }) {
  if (status === "running") return <MorphingSpinner className="size-3.5 text-sky-500" />;
  if (status === "completed") return <CheckCircle2 size={14} className="shrink-0 text-emerald-500" />;
  if (status === "failed") return <XCircle size={14} className="shrink-0 text-destructive" />;
  if (status === "paused") return <Pause size={13} className="shrink-0 text-amber-500" />;
  if (status === "awaiting") return <Sparkles size={13} className="shrink-0 text-indigo-500 dark:text-indigo-300" />;
  return <CircleDashed size={14} className="shrink-0 text-muted-foreground" />;
}

/**
 * 参考 Marked (@eliakuratli) Agent run status card 设计语言：
 * 紧凑抬头（状态灯 + 协调者头像 + 标题 + 状态胶囊 + 等宽耗时）与可折叠步骤时间线。
 */
export function AgentRunStatusCard({
  run,
  botsById,
  serversById,
  compact = false,
  defaultOpen = true,
  onAction,
}: AgentRunStatusCardProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(defaultOpen);
  const isLive = run.status === "queued" || run.status === "planning" || run.status === "running";
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!isLive) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isLive]);

  const coordinator = botsById.get(run.coordinatorBotId);
  const doneCount = run.steps.filter((step) => step.status === "completed").length;
  const elapsed = formatElapsed(run.startedAt, run.finishedAt ?? (isLive ? now : run.updatedAt));
  const boundCount = run.targetServerIds.filter((id) => serversById.has(id)).length;
  const envSummary =
    run.strategy === "local-only" || boundCount === 0
      ? t("team.env.local")
      : run.strategy === "servers-preferred"
        ? t("team.env.serversPreferredCount", { count: boundCount })
        : t("team.env.smartWithServers", { count: boundCount });

  const canControl = isLive || run.status === "paused" || run.status === "awaiting_runtime";

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <motion.div
        layout="position"
        initial={{ opacity: 0, y: 6 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className={cn("team-run-card", isLive && "is-active", compact && "max-w-none")}
      >
        <CollapsibleTrigger asChild>
          <button type="button" className="team-run-card-head">
            <div className="shrink-0">
              {coordinator ? (
                <SubagentLogo logo={coordinator.logo} name={coordinator.name} size={28} />
              ) : (
                <span className="inline-flex size-7 items-center justify-center rounded-full bg-muted text-muted-foreground">
                  <Sparkles size={14} />
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <span className="truncate text-[13px] font-medium text-foreground">{run.title}</span>
              </div>
              <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
                <span className="inline-flex items-center gap-1">
                  {boundCount > 0 && run.strategy !== "local-only" ? (
                    <CodexServerIcon className="size-3" />
                  ) : (
                    <Laptop size={11} />
                  )}
                  {envSummary}
                </span>
                <span aria-hidden="true">·</span>
                <span>{t(run.mode === "plan" ? "team.mode.plan" : "team.mode.execute")}</span>
                {run.steps.length > 0 && (
                  <>
                    <span aria-hidden="true">·</span>
                    <span className="tabular-nums">
                      {t("team.run.stepsCount", { done: doneCount, total: run.steps.length })}
                    </span>
                  </>
                )}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-2">
              <span className={cn("team-run-status-pill", `is-${run.status}`)}>
                {isLive ? (
                  <MorphingSpinner className="size-3" />
                ) : run.status === "awaiting_runtime" ? (
                  <span className="team-run-pulse" aria-hidden="true" />
                ) : null}
                {t(`team.run.status.${run.status}` as Parameters<typeof t>[0])}
              </span>

              <span className="hidden items-center gap-1 font-mono text-[11px] text-muted-foreground tabular-nums sm:inline-flex">
                <Clock3 size={11} />
                {elapsed}
              </span>

              <ChevronDown
                size={15}
                className={cn(
                  "text-muted-foreground transition-transform duration-200",
                  open && "rotate-180",
                )}
              />
            </div>
          </button>
        </CollapsibleTrigger>

        <CollapsibleContent forceMount>
          <AnimatePresence initial={false}>
            {open && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: "auto", opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.18, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="team-run-timeline">
                  {run.steps.map((step) => {
                    const bot = botsById.get(step.botId);
                    const targetServer = step.targetId ? serversById.get(step.targetId) : undefined;
                    return (
                      <div key={step.id} className="team-run-step">
                        <StepStatusIcon status={step.status} />
                        {bot && <SubagentLogo logo={bot.logo} name={bot.name} size={20} />}
                        <div className="min-w-0 flex-1">
                          <div className="truncate text-xs font-medium text-foreground">{step.title}</div>
                          {step.summary && (
                            <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{step.summary}</p>
                          )}
                        </div>
                        <span className="inline-flex shrink-0 items-center gap-1 rounded-md border border-border/70 bg-background px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                          {step.targetKind === "server" ? (
                            <CodexServerIcon className="size-2.5" />
                          ) : step.targetKind === "auto" ? (
                            <Sparkles size={10} />
                          ) : (
                            <Laptop size={10} />
                          )}
                          <span className="max-w-28 truncate">
                            {targetServer?.name ?? step.targetLabel ?? t("team.env.local")}
                          </span>
                        </span>
                      </div>
                    );
                  })}

                  {run.note && (
                    <p className="rounded-lg bg-muted/60 px-2.5 py-2 text-[11.5px] leading-relaxed text-muted-foreground">
                      {run.note}
                    </p>
                  )}

                  {canControl && (
                    <div className="flex items-center justify-end gap-1.5 pt-0.5">
                      {run.status === "paused" ? (
                        <button
                          type="button"
                          onClick={() => onAction("resume")}
                          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-accent"
                        >
                          <Play size={11} />
                          {t("team.run.resume")}
                        </button>
                      ) : (
                        <button
                          type="button"
                          onClick={() => onAction("pause")}
                          className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-accent"
                        >
                          <Pause size={11} />
                          {t("team.run.pause")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onAction("cancel")}
                        className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-muted-foreground hover:border-destructive/40 hover:text-destructive"
                      >
                        <Square size={10} />
                        {t("team.run.cancel")}
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </CollapsibleContent>
      </motion.div>
    </Collapsible>
  );
}
