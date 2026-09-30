import { translate, type Locale } from "../../localization";

export interface ToolGroupSummaryStep {
  verb: string;
  target?: string;
  chip?: string;
  fullTarget?: string;
}

/** Summarize the work performed, not the duration of the last model message. */
export function toolGroupSummary(steps: readonly ToolGroupSummaryStep[], locale: Locale): string {
  const verbMap = new Map<string, { count: number; targets: string[] }>();
  const verbOrder: string[] = [];

  for (const step of steps) {
    if (!verbMap.has(step.verb)) {
      verbOrder.push(step.verb);
      verbMap.set(step.verb, { count: 0, targets: [] });
    }
    const entry = verbMap.get(step.verb)!;
    entry.count += 1;
    const target = step.target?.trim() || step.chip?.trim();
    if (target && !entry.targets.includes(target)) {
      entry.targets.push(target);
    }
  }

  const isZh = locale === "zh-CN";
  const separator = isZh ? "、" : ", ";

  return verbOrder.map((verb) => {
    const { count, targets } = verbMap.get(verb)!;
    const baseCountLabel = translate(locale, "chat.toolGroupOperation", { operation: verb, count });
    if (targets.length === 0) {
      return baseCountLabel;
    }

    let targetsText: string;
    if (targets.length <= 3) {
      targetsText = targets.join(separator);
    } else {
      const head = targets.slice(0, 3).join(separator);
      targetsText = isZh
        ? `${head} 等 ${count} 项`
        : `${head} and ${count - 3} more`;
    }

    return `${baseCountLabel} (${targetsText})`;
  }).join(" · ");
}
