import { motion } from "motion/react";
import type { ScheduleInfo } from "@qone/protocol";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { Card, CardAction, CardContent, CardFooter, CardHeader, CardTitle } from "../ui/card";
import { Badge } from "../ui/badge";
import { Switch } from "../ui/switch";
import { Button } from "../ui/Button";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip";
import { CodexIcon } from "../ui/CodexIcon";
import { MorphingSpinner } from "../assistant-ui/morphing-spinner";
import clockIcon from "../../assets/codex-icons/clock-light-16.svg";
import chatIcon from "../../assets/codex-icons/chat-bubble-light-16.svg";
import playIcon from "../../assets/codex-icons/play-light-16.svg";
import { describeNext, describeRule, describeStatus } from "./schedule-format";

export interface ScheduleCardProps {
  schedule: ScheduleInfo;
  project?: string;
  connected: boolean;
  onEdit: (schedule: ScheduleInfo) => void;
  onToggle: (schedule: ScheduleInfo, enabled: boolean) => void;
  onRunNow: (schedule: ScheduleInfo) => void;
  onOpenChat: (sessionId: string) => void;
}

export function ScheduleCard({
  schedule,
  project,
  connected,
  onEdit,
  onToggle,
  onRunNow,
  onOpenChat,
}: ScheduleCardProps) {
  const { t, locale } = useLocale();
  const running = schedule.lastStatus === "running";
  const failed =
    !running &&
    (schedule.lastStatus === "failed" ||
      schedule.lastStatus === "interrupted" ||
      (!schedule.lastStatus && Boolean(schedule.lastError)));
  const completed = !running && !failed && schedule.lastStatus === "completed";
  const statusText = describeStatus(schedule, t, locale);
  const ruleText = describeRule(schedule.rule, t, locale);
  const nextText = describeNext(schedule, t, locale);

  return (
    <motion.li
      layout
      initial={{ opacity: 0, y: 6, scale: 0.985 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      exit={{ opacity: 0, scale: 0.97 }}
      transition={{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }}
      className="schedule-board-item"
    >
      <Card
        className={cn(
          "schedule-card",
          !schedule.enabled && "is-paused",
          running && "is-running",
          failed && "is-failed",
        )}
      >
        <button
          type="button"
          className="schedule-card-trigger"
          onClick={() => onEdit(schedule)}
          title={schedule.lastError || undefined}
          aria-label={`${schedule.title} (${t("schedules.edit")})`}
        />

        <CardHeader className="schedule-card-header">
          <CardTitle className="schedule-card-title" title={schedule.title}>
            {schedule.title}
          </CardTitle>
          <CardAction className="schedule-card-switch-wrap">
            <Switch
              checked={schedule.enabled}
              disabled={!connected}
              aria-label={t(schedule.enabled ? "schedules.disable" : "schedules.enable")}
              onCheckedChange={(checked) => onToggle(schedule, checked)}
            />
          </CardAction>
        </CardHeader>

        <CardContent className="schedule-card-body">
          <p className="schedule-card-prompt">{schedule.prompt}</p>
          <div className="schedule-card-meta">
            <Badge variant="secondary" className="schedule-card-rule">
              <CodexIcon src={clockIcon} className="size-3" />
              <span>{ruleText}</span>
            </Badge>
            <span className="schedule-card-next">
              {nextText}
              {project && (
                <>
                  <i aria-hidden="true">·</i>
                  {project}
                </>
              )}
            </span>
          </div>
        </CardContent>

        <CardFooter className="schedule-card-footer">
          <span
            className={cn(
              "schedule-card-status",
              running && "is-running",
              failed && "is-failed",
              completed && "is-completed",
            )}
          >
            {running ? <MorphingSpinner className="size-3" /> : <i aria-hidden="true" />}
            <span>{statusText}</span>
          </span>

          <div className="schedule-card-actions">
            {schedule.sessionId && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    className="schedule-card-icon-btn"
                    aria-label={t("schedules.openChat")}
                    onClick={() => onOpenChat(schedule.sessionId!)}
                  >
                    <CodexIcon src={chatIcon} className="size-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="top" sideOffset={6}>
                  {t("schedules.openChat")}
                </TooltipContent>
              </Tooltip>
            )}
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="schedule-card-icon-btn"
                  aria-label={t("schedules.runNow")}
                  disabled={running || !connected}
                  onClick={() => onRunNow(schedule)}
                >
                  <CodexIcon src={playIcon} className="size-3.5" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="top" sideOffset={6}>
                {t("schedules.runNow")}
              </TooltipContent>
            </Tooltip>
          </div>
        </CardFooter>
      </Card>
    </motion.li>
  );
}
