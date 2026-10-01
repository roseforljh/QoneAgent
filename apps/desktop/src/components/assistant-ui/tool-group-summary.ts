import { translate, type Locale } from "../../localization";
import type { ToolActivityCategory } from "./tool-activity-category";
import type { ToolIntegration } from "./tool-integration";

export interface ToolGroupSummaryStep {
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

const CATEGORY_LABELS = {
  "file-change": ["chat.toolGroupFileChangeOne", "chat.toolGroupFileChangeMany"],
  exploration: ["chat.toolGroupExplorationOne", "chat.toolGroupExplorationMany"],
  command: ["chat.toolGroupCommandOne", "chat.toolGroupCommandMany"],
  integration: ["chat.toolGroupToolOne", "chat.toolGroupToolMany"],
  tool: ["chat.toolGroupToolOne", "chat.toolGroupToolMany"],
  "web-search": ["chat.toolSearchedWeb", "chat.toolSearchedWeb"],
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
    const integrationNames = new Set<string>();
    let integrationsOnly = true;
    let failedCount = 0;
    for (const step of steps) {
      if (step.failed) {
        failedCount++;
        continue;
      }
      const category = step.category ?? "tool";
      if (category === "integration") {
        integrationNames.add(step.integration?.name ?? step.verb);
        if (step.integration?.kind === "source") integrationsOnly = false;
        continue;
      }
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
    const parts: string[] = [];
    for (const category of CATEGORY_ORDER) {
      let label: string;
      if (category === "integration") {
        if (!integrationNames.size) continue;
        const names = [...integrationNames];
        const sources = locale === "en"
          ? new Intl.ListFormat("en", { style: "long", type: "conjunction" }).format(names)
          : names.join("、");
        label = translate(locale, integrationsOnly ? names.length === 1 ? "chat.toolGroupIntegrationOne" : "chat.toolGroupIntegrationMany" : "chat.toolGroupSource", { sources });
      } else {
        const count = counts.get(category) ?? 0;
        if (!count) continue;
        label = translate(locale, CATEGORY_LABELS[category][count === 1 ? 0 : 1]);
      }
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

    // Width is a view concern: never discard targets before the fade/tooltip can show them.
    return `${baseCountLabel} (${targets.join(separator)})`;
  }).join(" · ");
}
