import type { ScheduleRule } from "@qone/protocol";

const MINUTE = 60_000;

function atTime(base: Date, time: string): Date {
  const [hours, minutes] = time.split(":").map(Number);
  const date = new Date(base);
  date.setHours(hours!, minutes!, 0, 0);
  return date;
}

/**
 * First fire time strictly after `after`, in local wall-clock time. `anchor`
 * is where an interval counts from (the last run, or when the task was saved).
 * Undefined means the task never fires again.
 */
export function nextRunAt(rule: ScheduleRule, after: number, anchor = after): number | undefined {
  switch (rule.kind) {
    case "once":
      return rule.at > after ? rule.at : undefined;
    case "interval": {
      const step = rule.minutes * MINUTE;
      // A long sleep skips the missed slots instead of firing each of them.
      const elapsed = Math.max(0, after - anchor);
      return anchor + (Math.floor(elapsed / step) + 1) * step;
    }
    case "daily":
    case "weekly": {
      const days = rule.kind === "weekly" ? new Set(rule.days) : undefined;
      const start = new Date(after);
      for (let offset = 0; offset <= 7; offset++) {
        const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset);
        if (days && !days.has(day.getDay())) continue;
        const candidate = atTime(day, rule.time).getTime();
        if (candidate > after) return candidate;
      }
      return undefined;
    }
  }
}
