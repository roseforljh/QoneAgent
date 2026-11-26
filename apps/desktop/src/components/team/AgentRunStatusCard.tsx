import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  Check,
  CheckCircle2,
  ChevronDown,
  CircleDashed,
  Clock3,
  Laptop,
  Pause,
  Play,
  ShieldAlert,
  Sparkles,
  Square,
  Wrench,
  X,
  XCircle,
} from "lucide-react";
import type { ServerInfo } from "@qone/protocol";
import type { TeamRunAction, TeamRunCard, TeamRunStep, TeamStepTarget } from "../../lib/team/types";
import { useTeamStore } from "../../lib/team/store";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "../ui/collapsible";
import { CodexServerIcon } from "../ui/CodexIcon";
import { MorphingSpinner } from "../assistant-ui/morphing-spinner";
import "./agent-run-card.css";

interface AgentRunStatusCardProps {
  run: TeamRunCard;
  step: TeamRunStep;
  serversById: ReadonlyMap<string, ServerInfo>;
  /** 对应机器人气泡是否已开始输出最终正文，用于判断是否自动收起执行过程。 */
  hasReplyText: boolean;
  /** 是否在该步骤卡片中展示任务级暂停/继续/确认/取消控制栏。 */
  showRunControls?: boolean;
  onAction: (action: TeamRunAction) => void;
}

const actionButton =
  "inline-flex h-6 items-center gap-1 rounded-md border border-border bg-[var(--q-surface)] px-2 text-[11px] font-medium text-foreground transition-colors hover:bg-accent";

/** 步骤真实使用过的执行环境标签；执行前展示路由预期。 */
function stepTargets(step: TeamRunStep): TeamStepTarget[] {
  if (step.targets?.length) return step.targets;
  return [{ kind: step.targetKind === "server" ? "server" : "local", id: step.targetId, label: step.targetLabel }];
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
  if (status === "completed") return <CheckCircle2 size={13} className="shrink-0 text-emerald-500" />;
  if (status === "failed") return <XCircle size={13} className="shrink-0 text-destructive" />;
  if (status === "paused") return <Pause size={12} className="shrink-0 text-amber-500" />;
  if (status === "awaiting") return <Sparkles size={12} className="shrink-0 text-indigo-500 dark:text-indigo-300" />;
  return <CircleDashed size={13} className="shrink-0 text-muted-foreground" />;
}

/** 判断该步骤是否值得在机器人气泡内展示执行过程卡片（纯问答且无工具调用的已完成回复不渲染空卡）。 */
export function shouldShowStepCard(run: TeamRunCard, step: TeamRunStep, hasReplyText: boolean): boolean {
  if (step.approval) return true;
  if (step.activity && step.activity.length > 0) return true;
  if (step.status === "failed" || step.status === "paused" || step.status === "awaiting") return true;
  if (run.status === "awaiting_confirmation" && step.kind === "plan") return true;
  // 正在执行且尚未开始纯文本汇总时实时展示状态卡；汇总步骤已开始输出正文时不再占位。
  if (step.status === "running") {
    const isSummary = step.kind === "summary" || step.id === "summary";
    return !isSummary || !hasReplyText;
  }
  return false;
}

/**
 * 嵌入机器人回复气泡内的单步执行过程卡片：
 * 每个成员独立展示自己的执行环境、实时工具明细与审批操作，开始输出总结或步骤完成时自动收起。
 */
export function AgentRunStatusCard({
  run,
  step,
  serversById,
  hasReplyText,
  showRunControls = false,
  onAction,
}: AgentRunStatusCardProps) {
  const { t } = useLocale();
  const activities = step.activity ?? [];
  const hasRunningTool = activities.some((entry) => entry.outcome === "running");
  const hasFailedOp = activities.some((entry) => entry.outcome === "failed" || entry.outcome === "blocked");
  const isSummaryStep = step.kind === "summary" || step.id === "summary";
  const isStepRunning = step.status === "running";
  const isRunLive = run.status === "queued" || run.status === "planning" || run.status === "running";
  const needsConfirmation = showRunControls && run.status === "awaiting_confirmation";
  const hasApproval = Boolean(step.approval);
  const approvalId = step.approval?.approvalId;

  // 进入总结输出（汇总步骤开始、已有工具且全部结束并开始输出正文）或本步骤结束时自动收起。
  const shouldAutoCollapse =
    !hasApproval &&
    !needsConfirmation &&
    (step.status === "completed" ||
      step.status === "failed" ||
      (isStepRunning && isSummaryStep) ||
      (isStepRunning && hasReplyText && !hasRunningTool && activities.length > 0));
  const isActivelyWorking = isStepRunning && !shouldAutoCollapse;

  const [open, setOpen] = useState(isActivelyWorking || hasApproval || needsConfirmation);
  const [now, setNow] = useState(() => Date.now());
  const prevRef = useRef({ activeWork: isActivelyWorking, shouldAutoCollapse });
  const resolveApproval = useTeamStore((state) => state.resolveApproval);

  useEffect(() => {
    if (approvalId || needsConfirmation) setOpen(true);
  }, [approvalId, needsConfirmation]);

  // 执行中实时展开，进入总结或步骤结束时自动收起，不干扰用户后续手动展开收起。
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = { activeWork: isActivelyWorking, shouldAutoCollapse };
    if (!prev.shouldAutoCollapse && shouldAutoCollapse) {
      setOpen(false);
    } else if (!prev.activeWork && isActivelyWorking) {
      setOpen(true);
    }
  }, [isActivelyWorking, shouldAutoCollapse]);

  useEffect(() => {
    if (!isStepRunning) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [isStepRunning]);

  const autoTarget = step.targetKind === "auto" && !step.targets?.length;
  const targets = autoTarget ? [] : stepTargets(step);
  const startTime = step.startedAt ?? run.startedAt;
  const endTime = step.finishedAt ?? (isStepRunning ? now : run.finishedAt ?? run.updatedAt);
  const elapsed = formatElapsed(startTime, endTime);
  const canControl = showRunControls && (isRunLive || run.status === "paused" || run.status === "awaiting_confirmation");
  const hasBodyContent = activities.length > 0 || hasApproval || canControl || Boolean(step.instruction) || (showRunControls && Boolean(run.note));

  return (
    <Collapsible open={open} onOpenChange={setOpen} className="w-full min-w-0">
      <div
        data-run-id={run.id}
        data-step-id={step.id}
        className={cn(
          "team-step-card",
          isStepRunning && "is-active",
          (hasApproval || needsConfirmation) && "is-attention",
          step.status === "failed" && "is-failed",
        )}
      >
        {/* 顶部极细进度条：当前步骤活跃执行时展示 */}
        {(isStepRunning || step.status === "paused" || needsConfirmation) && (
          <div className="team-run-progress" aria-hidden="true">
            <div
              className={cn("team-run-progress-bar", isStepRunning && "is-live")}
              style={{ width: isStepRunning ? "62%" : "100%" }}
            />
          </div>
        )}

        <CollapsibleTrigger asChild>
          <button
            type="button"
            className="team-step-card-head"
            aria-label={t(open ? "team.run.collapse" : "team.run.expand")}
          >
            <StepStatusIcon status={step.status} />

            <span className="min-w-0 flex-1 truncate text-[12px] font-medium text-foreground">
              {step.title}
            </span>

            <div className="flex shrink-0 items-center gap-1.5">
              {autoTarget ? (
                <span className="team-run-meta-chip">
                  <Sparkles size={10} />
                  <span className="max-w-20 truncate">{t("team.env.smart")}</span>
                </span>
              ) : (
                targets.slice(0, 2).map((target) => (
                  <span key={`${target.kind}:${target.id ?? ""}`} className="team-run-meta-chip">
                    {target.kind === "server" ? <CodexServerIcon className="size-2.5 shrink-0" /> : <Laptop size={10} className="shrink-0" />}
                    <span className="max-w-20 truncate">
                      {target.kind === "server"
                        ? (target.id ? serversById.get(target.id)?.name : undefined) ?? target.label ?? ""
                        : t("team.env.local")}
                    </span>
                  </span>
                ))
              )}

              {activities.length > 0 && (
                <span className={cn("team-step-ops-badge", hasFailedOp && "is-warn")}>
                  <Wrench size={10} />
                  <span className="tabular-nums">{t("team.run.operationsCount", { count: activities.length })}</span>
                </span>
              )}

              <span className="hidden items-center gap-1 font-mono text-[10.5px] text-muted-foreground tabular-nums sm:inline-flex">
                <Clock3 size={10} />
                {elapsed}
              </span>

              <ChevronDown
                size={13}
                className={cn(
                  "shrink-0 text-muted-foreground transition-transform duration-150",
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
                transition={{ duration: 0.16, ease: "easeOut" }}
                className="overflow-hidden"
              >
                <div className="team-step-card-body">
                  {step.instruction && (
                    <p className="text-[11.5px] leading-relaxed text-muted-foreground">
                      {step.instruction}
                    </p>
                  )}

                  {activities.length > 0 && (
                    <div className="team-run-ops-panel">
                      <ul className="team-run-ops-list is-scrollable">
                        {activities.map((entry, index) => {
                          const outcome = entry.outcome === "running" && step.status !== "running" ? "interrupted" : entry.outcome;
                          return (
                            <li key={entry.id ?? `${entry.tool}-${index}`} className="team-run-ops-row">
                              <span className="team-run-ops-tool">{entry.tool}</span>
                              {entry.detail && (
                                <span className="min-w-0 flex-1 truncate font-mono text-[11px] text-muted-foreground" title={entry.detail}>
                                  {entry.detail}
                                </span>
                              )}
                              <span
                                className={cn(
                                  "ml-auto shrink-0 text-[10.5px] font-medium",
                                  outcome === "failed" || outcome === "blocked"
                                    ? "text-destructive"
                                    : outcome === "running"
                                      ? "text-sky-600 dark:text-sky-300"
                                      : "text-muted-foreground",
                                )}
                              >
                                {t(`team.run.activity.${outcome}`)}
                              </span>
                            </li>
                          );
                        })}
                      </ul>
                    </div>
                  )}

                  {!hasBodyContent && isStepRunning && (
                    <p className="text-[11.5px] text-muted-foreground">
                      {t(`team.run.step.${step.status}` as Parameters<typeof t>[0])}
                    </p>
                  )}

                  {step.approval && (
                    <div className="team-run-approval">
                      <div className="flex items-center gap-1.5 text-xs font-medium">
                        <ShieldAlert size={13} className="shrink-0" />
                        <span className="min-w-0 break-words">
                          {t("team.run.approvalNeeded", { tool: step.approval.toolName })}
                        </span>
                      </div>
                      {step.approval.detail && (
                        <pre className="team-run-approval-code">{step.approval.detail}</pre>
                      )}
                      <div className="flex flex-wrap justify-end gap-1.5">
                        <button
                          type="button"
                          className={actionButton}
                          onClick={() => resolveApproval(step.approval!.approvalId, false)}
                        >
                          <X size={12} />
                          {t("team.run.reject")}
                        </button>
                        <button
                          type="button"
                          className="inline-flex h-6 items-center gap-1 rounded-md bg-foreground px-2 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
                          onClick={() => resolveApproval(step.approval!.approvalId, true)}
                        >
                          <Check size={12} />
                          {t("team.run.approve")}
                        </button>
                      </div>
                    </div>
                  )}

                  {showRunControls && run.note && (
                    <p className="rounded-lg bg-muted/55 px-2.5 py-1.5 text-[11.5px] leading-relaxed text-muted-foreground">
                      {run.note}
                    </p>
                  )}

                  {canControl && (
                    <div className="team-run-footer">
                      {run.status === "awaiting_confirmation" ? (
                        <button
                          type="button"
                          onClick={() => onAction("confirm_plan")}
                          className="inline-flex h-6 items-center gap-1 rounded-md bg-foreground px-2 text-[11px] font-medium text-background transition-opacity hover:opacity-90"
                        >
                          <Play size={10} />
                          {t("team.run.confirm")}
                        </button>
                      ) : run.status === "paused" ? (
                        <button type="button" onClick={() => onAction("resume")} className={actionButton}>
                          <Play size={10} />
                          {t("team.run.resume")}
                        </button>
                      ) : (
                        <button type="button" onClick={() => onAction("pause")} className={actionButton}>
                          <Pause size={10} />
                          {t("team.run.pause")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onAction("cancel")}
                        className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-[var(--q-surface)] px-2 text-[11px] font-medium text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
                      >
                        <Square size={9} />
                        {t("team.run.cancel")}
                      </button>
                    </div>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </CollapsibleContent>
      </div>
    </Collapsible>
  );
}
