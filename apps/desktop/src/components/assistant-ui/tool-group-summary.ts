import { translate, type Locale } from "../../localization";
import type { ToolActivityCategory } from "./tool-activity-category";

export interface ToolGroupSummaryStep {
  verb: string;
  target?: string;
  chip?: string;
  fullTarget?: string;
  category?: ToolActivityCategory;
  filePaths?: string[];
  failed?: boolean;
}

const CATEGORY_ORDER: readonly ToolActivityCategory[] = [
  "file-change",
  "exploration",
  "command",
  "tool",
];

const CATEGORY_LABELS = {
  "file-change": ["chat.toolGroupFileChangeOne", "chat.toolGroupFileChangeMany"],
  exploration: ["chat.toolGroupExplorationOne", "chat.toolGroupExplorationMany"],
  command: ["chat.toolGroupCommandOne", "chat.toolGroupCommandMany"],
  tool: ["chat.toolGroupToolOne", "chat.toolGroupToolMany"],
} as const;

/** Summarize the work performed, not the duration of the last model message. */
export function toolGroupSummary(
  steps: readonly ToolGroupSummaryStep[],
  locale: Locale,
  { fullTargets = false }: { fullTargets?: boolean } = {},
): string {
  const categorized = steps.some((step) => step.category !== undefined);
  if (categorized) {
    const counts = new Map<ToolActivityCategory, number>();
    const changedPaths = new Set<string>();
    let failedCount = 0;
    for (const step of steps) {
      if (step.failed) {
        failedCount++;
        continue;
      }
      const category = step.category ?? "tool";
      if (category === "file-change") {
        if (step.filePaths?.length) {
          step.filePaths.forEach((path) => changedPaths.add(path));
          continue;
        }
        const path = step.fullTarget ?? step.target ?? step.chip;
        if (path) {
          changedPaths.add(path);
          continue;
        }
      }
      counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    counts.set("file-change", (counts.get("file-change") ?? 0) + changedPaths.size);
    const parts = CATEGORY_ORDER
      .filter((category) => (counts.get(category) ?? 0) > 0)
      .map((category, index) => {
        const count = counts.get(category)!;
        const key = CATEGORY_LABELS[category][count === 1 ? 0 : 1];
        const label = translate(locale, key);
        return locale === "en" && index > 0 ? label[0]!.toLowerCase() + label.slice(1) : label;
      });
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

    // Width is a view concern: never discard targets before the fade/tooltip can show them.
    return `${baseCountLabel} (${targets.join(separator)})`;
  }).join(" · ");
}
