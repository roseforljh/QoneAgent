import type { Locale } from "../../localization";
import { translate } from "../../localization";
import { formatDuration } from "../../lib/utils";
import type { ToolCall } from "../../store";
import { toolCallStatus } from "./tool-call-display";

type ToolActionPart = {
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  status?: { type: string };
};

const COMMAND_TOOL_NAMES = new Set(["bash", "powershell", "shell", "sh", "exec", "run", "run_command"]);

export function isCommandTool(part: Pick<ToolActionPart, "toolName">): boolean {
  return COMMAND_TOOL_NAMES.has(part.toolName.toLowerCase());
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function compactText(value: string, maxLength = 56): string {
  const text = value.replace(/\s+/g, " ").trim();
  if (text.length <= maxLength) return text;
  return `${text.slice(0, Math.max(1, maxLength - 3)).trimEnd()}...`;
}

export function commandForTool(part: ToolActionPart, call?: ToolCall): string | undefined {
  const args = { ...asObject(call?.args), ...asObject(part.args) };
  const command = firstString([args.command, args.cmd, args.script, args.shellCommand]);
  if (command) return command;
  return isCommandTool(part)
    ? firstString([part.args, call?.args])
    : undefined;
}

export function toolTarget(part: ToolActionPart, call?: ToolCall): string {
  const args = { ...asObject(call?.args), ...asObject(part.args) };
  const command = commandForTool(part, call);
  if (command) return compactText(command);
  const path = firstString([args.path, args.file]);
  if (path) {
    const normalized = path.trim().replace(/[\\/]+$/, "");
    return compactText(normalized.split(/[\\/]/).at(-1) || normalized);
  }
  return compactText(firstString([args.pattern, args.query, args.url, args.name]) ?? part.toolName);
}

function elapsedSeconds(call: ToolCall | undefined, now: number): number | undefined {
  if (call?.startedAt === undefined || !Number.isFinite(call.startedAt)) return undefined;
  const end = call.completedAt ?? now;
  if (!Number.isFinite(end)) return undefined;
  return Math.max(0, (end - call.startedAt) / 1000);
}

function formatToolDuration(seconds: number, locale: Locale): string {
  if (seconds < 1) return translate(locale, "chat.toolDurationLessThanSecond");
  return formatDuration(seconds, locale);
}

export function toolActionSummary(
  part: ToolActionPart,
  step: { verb: string; target: string },
  call: ToolCall | undefined,
  active: boolean,
  now: number,
  locale: Locale,
): string {
  const duration = elapsedSeconds(call, now);
  const failed = toolCallStatus(part, call) === "failed";
  if (commandForTool(part, call)) {
    if (active) {
      return duration === undefined
        ? translate(locale, "chat.toolSummaryRunningCommandFallback", { target: step.target })
        : translate(locale, "chat.toolSummaryRunningCommand", { duration: formatToolDuration(duration, locale), target: step.target });
    }
    if (failed) return translate(locale, "chat.toolSummaryFailedCommand");
    return duration === undefined
      ? translate(locale, "chat.toolSummaryCompletedCommandFallback")
      : translate(locale, "chat.toolSummaryCompletedCommand", { duration: formatToolDuration(duration, locale) });
  }
  if (active) return translate(locale, "chat.toolSummaryRunning", { operation: step.verb, target: step.target });
  if (failed) return translate(locale, "chat.toolSummaryFailed", { operation: step.verb, target: step.target });
  return translate(locale, "chat.toolSummaryCompleted", { operation: step.verb, target: step.target });
}
