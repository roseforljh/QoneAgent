import type { Locale } from "../../localization";
import { translate } from "../../localization";
import { formatDuration } from "../../lib/utils";
import type { ToolCall } from "../../store";
import { toolCallStatus } from "./tool-call-display";
import { isCommandTool } from "./tool-activity-category";

type ToolActionPart = {
  toolName: string;
  args?: unknown;
  result?: unknown;
  isError?: boolean;
  status?: { type: string };
};

export { isCommandTool } from "./tool-activity-category";

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function firstString(values: unknown[]): string | undefined {
  return values.find((value): value is string => typeof value === "string" && value.trim().length > 0);
}

function compactText(value: string): string {
  // Normalize the single-line preview without losing content to a character cutoff.
  return value.replace(/\s+/g, " ").trim();
}

function displayToolName(toolName: string): string {
  if (toolName.startsWith("mcp:")) return toolName.split(":").at(-1) || "tool";
  return toolName;
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

  const toolName = part.toolName.toLowerCase();
  const isSearchOrFind = ["grep", "find", "glob", "search"].some((name) => toolName.includes(name));

  if (isSearchOrFind) {
    const pattern = firstString([args.pattern, args.query]);
    const path = firstString([args.path, args.file]);
    if (pattern) {
      if (path) {
        const normalized = path.trim().replace(/[\\/]+$/, "");
        const base = normalized.split(/[\\/]/).at(-1) || normalized;
        return compactText(`${pattern} (${base})`);
      }
      return compactText(pattern);
    }
  }

  const path = firstString([args.path, args.file]);
  if (path) {
    const normalized = path.trim().replace(/[\\/]+$/, "");
    return compactText(normalized.split(/[\\/]/).at(-1) || normalized);
  }
  return compactText(firstString([args.pattern, args.query, args.url, args.name]) ?? displayToolName(part.toolName));
}

export function toolFullTarget(part: ToolActionPart, call?: ToolCall): string {
  const args = { ...asObject(call?.args), ...asObject(part.args) };
  const command = commandForTool(part, call);
  if (command) return command;

  const toolName = part.toolName.toLowerCase();
  const isSearchOrFind = ["grep", "find", "glob", "search"].some((name) => toolName.includes(name));

  if (isSearchOrFind) {
    const pattern = firstString([args.pattern, args.query]);
    const path = firstString([args.path, args.file]);
    if (pattern && path) return `${pattern} in ${path}`;
    if (pattern) return pattern;
  }

  const path = firstString([args.path, args.file]);
  if (path) return path;

  return firstString([args.pattern, args.query, args.url, args.name]) ?? displayToolName(part.toolName);
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
