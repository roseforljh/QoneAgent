import { translate, type Locale } from "../../localization";

export interface ToolGroupSummaryStep {
  verb: string;
  target?: string;
  chip?: string;
  fullTarget?: string;
}

/** Summarize the work performed, not the duration of the last model message. */
export function toolGroupSummary(
  steps: readonly ToolGroupSummaryStep[],
  locale: Locale,
  { fullTargets = false }: { fullTargets?: boolean } = {},
): string {
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
