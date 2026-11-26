import { translate, type Locale } from "../../localization";
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

const CATEGORY_ORDER: readonly ToolActivityCategory[] = [
  "integration",
  "file-change",
  "exploration",
  "command",
  "web-search",
  "tool",
];

const READ_TOOL_NAMES = new Set(["read", "qone_video_use_file"]);

function basename(path: string): string {
  const normalized = path.trim().replace(/[\\/]+$/, "");
  return normalized.split(/[\\/]/).at(-1) || normalized;
}

function formatInlineList(items: readonly string[], locale: Locale): string {
  return locale === "en"
    ? new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(items)
    : items.join("、");
}

function pushUnique(list: string[], value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed && !list.includes(trimmed)) list.push(trimmed);
}

/** 汇总本组实际完成的动作，优先带上具体文件名与目标，避免空洞的硬编码播报。 */
export function toolGroupSummary(
  steps: readonly ToolGroupSummaryStep[],
  locale: Locale,
  { fullTargets = false }: { fullTargets?: boolean } = {},
): string {
  const categorized = steps.some((step) => step.category !== undefined);
  if (categorized) {
    const counts = new Map<ToolActivityCategory, number>();
    const changedFiles: string[] = [];
    const explorationTargets: string[] = [];
    let explorationReadOnly = true;
    const integrationNames: string[] = [];
    let webSourceOnly = true;
    let failedCount = 0;

    for (const step of steps) {
      if (step.failed) {
        failedCount++;
        continue;
      }
      const category = step.category ?? "tool";
      if (category === "integration") {
        const name = step.integration?.name ?? step.verb;
        pushUnique(integrationNames, name);
        if (step.integration?.id !== "web") webSourceOnly = false;
        continue;
      }
      if (category === "file-change") {
        if (step.filePaths?.length) {
          step.filePaths.forEach((path) => pushUnique(changedFiles, fullTargets ? path : basename(path)));
          continue;
        }
        const path = fullTargets ? (step.fullTarget ?? step.target ?? step.chip) : (step.target ?? step.chip ?? (step.fullTarget ? basename(step.fullTarget) : undefined));
        if (path) {
          pushUnique(changedFiles, path);
          continue;
        }
      }
      if (category === "exploration") {
        if (step.toolName && !READ_TOOL_NAMES.has(step.toolName)) explorationReadOnly = false;
        const target = (fullTargets ? step.fullTarget?.trim() : undefined) || step.target?.trim() || step.chip?.trim();
        pushUnique(explorationTargets, target);
      }
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }

    const fileChangeCount = Math.max(counts.get("file-change") ?? 0, changedFiles.length);
    if (fileChangeCount > 0) counts.set("file-change", fileChangeCount);

    const parts: string[] = [];
    for (const category of CATEGORY_ORDER) {
      let label: string | undefined;
      if (category === "integration") {
        if (!integrationNames.length) continue;
        if (webSourceOnly && integrationNames.length === 1) {
          label = translate(locale, "chat.toolReadWeb");
        } else {
          label = translate(locale, "chat.toolGroupSource", { sources: formatInlineList(integrationNames, locale) });
        }
      } else if (category === "file-change") {
        const count = counts.get("file-change") ?? 0;
        if (!count) continue;
        if (changedFiles.length > 0 && (fullTargets || changedFiles.length <= 2)) {
          label = translate(locale, "chat.toolGroupFileChangeNamed", { files: formatInlineList(changedFiles, locale) });
        } else {
          label = translate(locale, count === 1 ? "chat.toolGroupFileChangeOne" : "chat.toolGroupFileChangeMany", { count });
        }
      } else if (category === "exploration") {
        const count = counts.get("exploration") ?? 0;
        if (!count) continue;
        if (explorationTargets.length > 0 && (fullTargets || explorationTargets.length <= 2)) {
          label = translate(
            locale,
            explorationReadOnly ? "chat.toolGroupReadNamed" : "chat.toolGroupExploreNamed",
            { targets: formatInlineList(explorationTargets, locale) },
          );
        } else if (explorationReadOnly) {
          label = explorationTargets.length > 0
            ? translate(locale, "chat.toolGroupReadCount", { count: explorationTargets.length })
            : translate(locale, count === 1 ? "chat.toolGroupExplorationOne" : "chat.toolGroupExplorationMany");
        } else {
          label = explorationTargets.length > 0
            ? translate(locale, "chat.toolGroupExploreCount", { count: explorationTargets.length })
            : translate(locale, "chat.toolGroupExplorationMany");
        }
      } else if (category === "command") {
        const count = counts.get("command") ?? 0;
        if (!count) continue;
        label = translate(locale, count === 1 ? "chat.toolGroupCommandOne" : "chat.toolGroupCommandMany", { count });
      } else if (category === "web-search") {
        const count = counts.get("web-search") ?? 0;
        if (!count) continue;
        label = translate(locale, "chat.toolSearchedWeb");
      } else if (category === "tool") {
        const hasConcreteAction = (counts.get("file-change") ?? 0) > 0
          || (counts.get("command") ?? 0) > 0
          || (counts.get("exploration") ?? 0) > 0
          || (counts.get("web-search") ?? 0) > 0
          || integrationNames.length > 0;
        if (hasConcreteAction) continue;
        const count = counts.get("tool") ?? 0;
        if (!count) continue;
        label = translate(locale, count === 1 ? "chat.toolGroupToolOne" : "chat.toolGroupToolMany", { count });
      }
      if (!label) continue;
      parts.push(locale === "en" && parts.length > 0 ? label[0]!.toLowerCase() + label.slice(1) : label);
    }

    if (failedCount > 0) {
      const label = translate(locale, failedCount === 1 ? "chat.toolGroupFailedOne" : "chat.toolGroupFailedMany", { count: failedCount });
      parts.push(locale === "en" && parts.length > 0 ? label[0]!.toLowerCase() + label.slice(1) : label);
    }
    return locale === "en"
      ? new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(parts)
      : parts.join("，");
  }

  const verbMap = new Map<string, { count: number; targets: string[] }>();
  const verbOrder: string[] = [];

  for (const step of steps) {
    if (!verbMap.has(step.verb)) {
      verbOrder.push(step.verb);
      verbMap.set(step.verb, { count: 0, targets: [] });
    }
    const entry = verbMap.get(step.verb)!;
    entry.count += 1;
    const target = (fullTargets ? step.fullTarget?.trim() : undefined) || step.target?.trim() || step.chip?.trim();
    if (target && !entry.targets.includes(target)) {
      entry.targets.push(target);
    }
  }

  const separator = locale === "zh-CN" ? "、" : ", ";

  return verbOrder.map((verb) => {
    const { count, targets } = verbMap.get(verb)!;
    const baseCountLabel = translate(locale, "chat.toolGroupOperation", { operation: verb, count });
    if (targets.length === 0) {
      return baseCountLabel;
    }

    return `${baseCountLabel} (${targets.join(separator)})`;
  }).join(" · ");
}
