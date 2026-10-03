import type { Locale, MessageKey } from "../../localization";
import { ACTIVITY_TITLE_TOOL } from "@qone/protocol";
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

const OPERATION_LABELS = new Map<string, readonly [MessageKey, MessageKey]>([
  ["dispatch_subagent", ["chat.toolCreatingSubagent", "chat.toolCreatedSubagent"]],
  ["run_subagent_workflow", ["chat.toolRunningSubagentWorkflow", "chat.toolRanSubagentWorkflow"]],
  ["inspect_subagent", ["chat.toolReadingSubagent", "chat.toolReadSubagent"]],
  ["control_subagent", ["chat.toolControllingSubagent", "chat.toolControlledSubagent"]],
  ["wait_subagent", ["chat.toolWaitingSubagent", "chat.toolWaitedSubagent"]],
  [ACTIVITY_TITLE_TOOL, ["chat.toolUpdatingStageTitle", "chat.toolUpdatedStageTitle"]],
  ["read", ["chat.toolReading", "chat.toolRead"]],
  ["grep", ["chat.toolSearching", "chat.toolSearched"]],
  ["find", ["chat.toolFinding", "chat.toolFound"]],
  ["glob", ["chat.toolFinding", "chat.toolFound"]],
  ["ls", ["chat.toolListing", "chat.toolListed"]],
  ["write", ["chat.toolWriting", "chat.toolWritten"]],
  ["edit", ["chat.toolEditing", "chat.toolEdited"]],
  ["apply_patch", ["chat.toolPatching", "chat.toolPatched"]],
  ["web_search", ["chat.toolSearchingWeb", "chat.toolSearchedWeb"]],
  ["web_fetch", ["chat.toolReadingWeb", "chat.toolReadWeb"]],
]);
const QUERY_TOOLS = new Set(["grep", "find", "glob", "search", "web_search"]);

/** Individual rows describe an action; category summaries belong to group headers. */
export function toolOperationLabels(part: ToolActionPart, operation: string, locale: Locale): { active: string; completed: string } {
  const keys = OPERATION_LABELS.get(part.toolName);
  if (keys) return { active: translate(locale, keys[0]), completed: translate(locale, keys[1]) };
  if (isCommandTool(part)) return {
    active: translate(locale, "chat.toolRunningCommand"),
    completed: translate(locale, "chat.toolRanCommand"),
  };
  return {
    active: translate(locale, "chat.toolCallingOperation", { operation }),
    completed: translate(locale, "chat.toolCalledOperation", { operation }),
  };
}

export function toolPreparationLabel(part: ToolActionPart, step: { verb: string; integration?: { name: string } }, locale: Locale): string {
  if (step.integration) return translate(locale, "chat.toolPreparingIntegration", { name: step.integration.name });
  if (OPERATION_LABELS.has(part.toolName) || isCommandTool(part)) return translate(locale, "chat.toolPreparingAction", {
    operation: locale === "en" ? step.verb.toLowerCase() : step.verb,
  });
  return translate(locale, "chat.toolPreparingOperation");
}

export function commandForTool(part: ToolActionPart, call?: ToolCall): string | undefined {
  if (!isCommandTool(part)) return undefined;
  const args = { ...asObject(part.args), ...asObject(call?.args) };
  const command = firstString([args.command, args.cmd, args.script, args.shellCommand]);
  if (command) return command;
  return firstString([call?.args, part.args]);
}

export function toolTarget(part: ToolActionPart, call?: ToolCall): string {
  const args = { ...asObject(part.args), ...asObject(call?.args) };
  const command = commandForTool(part, call);
  if (command) return compactText(command);

  const toolName = part.toolName.toLowerCase();
  const isSearchOrFind = QUERY_TOOLS.has(toolName);

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
  return compactText(firstString([args.pattern, args.query, args.url, args.name, args.command, args.cmd]) ?? "");
}

export function toolFullTarget(part: ToolActionPart, call?: ToolCall): string {
  const args = { ...asObject(part.args), ...asObject(call?.args) };
  const command = commandForTool(part, call);
  if (command) return command;

  const toolName = part.toolName.toLowerCase();
  const isSearchOrFind = QUERY_TOOLS.has(toolName);

  if (isSearchOrFind) {
    const pattern = firstString([args.pattern, args.query]);
    const path = firstString([args.path, args.file]);
    if (pattern && path) return `${pattern} in ${path}`;
    if (pattern) return pattern;
  }

  const path = firstString([args.path, args.file]);
  if (path) return path;

  return firstString([args.pattern, args.query, args.url, args.name, args.command, args.cmd]) ?? "";
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
  step: { verb: string; target: string; integration?: { name: string } },
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
  const labels = toolOperationLabels(part, step.verb, locale);
  if (active) return [step.integration ? translate(locale, "chat.toolUsingIntegration", { name: step.integration.name }) : labels.active, step.target].filter(Boolean).join(" ");
  if (failed) return translate(locale, "chat.toolSummaryFailed", { operation: step.verb, target: step.target });
  return [labels.completed, step.target].filter(Boolean).join(" ");
}
