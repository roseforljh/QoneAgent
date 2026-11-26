import type { ScheduleInfo, ScheduleInput, ScheduleRule } from "@qone/protocol";
import type { Locale, MessageKey } from "../../localization";

type Translate = (key: MessageKey, values?: Record<string, string | number>) => string;

/** Monday first, as people read a week. */
export const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0] as const;
const WEEKDAYS = [1, 2, 3, 4, 5];

export function formatMoment(at: number, locale: Locale): string {
  return new Intl.DateTimeFormat(locale, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(at);
}

export function describeRule(rule: ScheduleRule, t: Translate, locale: Locale): string {
  switch (rule.kind) {
    case "daily": return t("schedules.ruleDaily", { time: rule.time });
    case "weekly": {
      const days = [...rule.days].sort((a, b) => WEEK_ORDER.indexOf(a as never) - WEEK_ORDER.indexOf(b as never));
      if (days.length === 7) return t("schedules.ruleDaily", { time: rule.time });
      if (days.join() === WEEKDAYS.join()) return t("schedules.ruleWeekdays", { time: rule.time });
      return t("schedules.ruleWeekly", { days: days.map((day) => t(`schedules.weekday.${day}` as MessageKey)).join(locale === "en" ? ", " : "、"), time: rule.time });
    }
    case "interval": return rule.minutes % 60 === 0
      ? t("schedules.ruleHours", { count: rule.minutes / 60 })
      : t("schedules.ruleMinutes", { count: rule.minutes });
    case "once": return t("schedules.ruleOnce", { time: formatMoment(rule.at, locale) });
  }
}

/** One status line: what happened last, or when it runs next. */
export function describeStatus(schedule: ScheduleInfo, t: Translate, locale: Locale): string {
  if (schedule.lastStatus === "running") return t("schedules.status.running");
  if (schedule.lastStatus && schedule.lastStatus !== "completed") return t(`schedules.status.${schedule.lastStatus}`);
  if (schedule.lastError) return schedule.lastError;
  if (schedule.lastStatus === "completed" && schedule.lastRunAt) return t("schedules.status.completed", { time: formatMoment(schedule.lastRunAt, locale) });
  return t("schedules.status.never");
}

export function describeNext(schedule: ScheduleInfo, t: Translate, locale: Locale): string {
  if (schedule.enabled && schedule.nextRunAt) return t("schedules.next", { time: formatMoment(schedule.nextRunAt, locale) });
  return t(schedule.rule.kind === "once" && schedule.lastRunAt ? "schedules.finished" : "schedules.paused");
}

export function scheduleInput(schedule: ScheduleInfo): ScheduleInput {
  const { id, title, prompt, workspaceId, sessionId, rule, enabled, model, permissionMode, thinking } = schedule;
  return { id, title, prompt, workspaceId, sessionId, rule, enabled, model, permissionMode, thinking };
}

/** `<input type="datetime-local">` speaks local time without a zone. */
export function toLocalInput(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
