import { translate, type Locale } from "../../localization";
import { toolOperationLabels } from "./tool-action-summary";
import type { ToolActivityCategory } from "./tool-activity-category";
import type { ToolIntegration } from "./tool-integration";

export interface ToolGroupSummaryStep {
  toolName?: string;
  verb: string;
  target?: string;
  chip?: string;
  fullTarget?: string;
  category?: ToolActivityCategory;
  filePaths?: string[];
  failed?: boolean;
  integration?: ToolIntegration;
}

const READ_TOOL_NAMES = new Set(["read", "qone_video_use_file"]);

function basename(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || normalized;
}

function uniquePaths(paths: readonly string[], fullTargets: boolean): string[] {
  const result: string[] = [];
  for (const path of paths) {
    const value = (fullTargets ? path : basename(path)).trim();
    if (value && !result.includes(value)) result.push(value);
  }
  return result;
}

function stepTarget(step: ToolGroupSummaryStep, fullTargets: boolean): string {
  return (fullTargets ? step.fullTarget?.trim() : undefined) || step.target?.trim() || step.chip?.trim() || "";
}

/** 选取本组最新有效操作；若末尾为通用辅助工具，则回退到最近一次具体操作。 */
export function latestSummaryStep<T extends ToolGroupSummaryStep>(steps: readonly T[]): T | undefined {
  for (let index = steps.length - 1; index >= 0; index--) {
    const step = steps[index]!;
    if (step.failed || step.category !== "tool") return step;
  }
  return steps.at(-1);
}

/** 仅展示本组最新一条操作，保持单行简洁，不拼接多类逗号摘要。 */
export function toolGroupSummary(
  steps: readonly ToolGroupSummaryStep[],
  locale: Locale,
  { fullTargets = false }: { fullTargets?: boolean } = {},
): string {
  const step = latestSummaryStep(steps);
  if (!step) return "";

  const target = stepTarget(step, fullTargets);

  if (step.failed) {
    if (step.category === "command" && !target) return translate(locale, "chat.toolSummaryFailedCommand");
    const label = translate(locale, "chat.toolActionFailed", { operation: step.integration?.name ?? step.verb });
    return target ? `${label} ${target}` : label;
  }

  if (step.category === "integration") {
    if (step.integration?.id === "web") return translate(locale, "chat.toolReadWeb");
    return translate(locale, "chat.toolGroupSource", { sources: step.integration?.name ?? step.verb });
  }

  if (step.category === "file-change") {
    const files = step.filePaths?.length ? uniquePaths(step.filePaths, fullTargets) : [];
    if (files.length > 1) return translate(locale, "chat.toolGroupFileChangeMany", { count: files.length });
    const file = files[0] || (fullTargets
      ? (step.fullTarget ?? step.target ?? step.chip)?.trim()
      : (step.target ?? step.chip ?? (step.fullTarget ? basename(step.fullTarget) : undefined))?.trim());
    return file
      ? translate(locale, "chat.toolGroupFileChangeNamed", { files: file })
      : translate(locale, "chat.toolGroupFileChangeOne");
  }

  if (step.category === "command") {
    return target
      ? `${translate(locale, "chat.toolRanCommand")} ${target}`
      : translate(locale, "chat.toolGroupCommandOne");
  }

  if (step.category === "web-search") {
    const label = translate(locale, "chat.toolSearchedWeb");
    return target ? `${label} ${target}` : label;
  }

  if (step.category === "exploration") {
    if (step.toolName) {
      if (target) {
        const label = toolOperationLabels({ toolName: step.toolName }, step.verb, locale).completed;
        return `${label} ${target}`;
      }
      return translate(locale, READ_TOOL_NAMES.has(step.toolName) ? "chat.toolGroupExplorationOne" : "chat.toolGroupExplorationMany");
    }
    return target
      ? translate(locale, "chat.toolGroupReadNamed", { targets: target })
      : translate(locale, "chat.toolGroupExplorationOne");
  }

  if (step.toolName) {
    const label = toolOperationLabels({ toolName: step.toolName }, step.verb, locale).completed;
    return target ? `${label} ${target}` : label;
  }

  if (step.category === "tool" && !target) {
    return translate(locale, "chat.toolGroupToolOne");
  }

  return target ? `${step.verb} ${target}` : step.verb;
}
