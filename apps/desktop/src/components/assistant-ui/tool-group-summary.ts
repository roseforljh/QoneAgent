import { translate, type Locale } from "../../localization";

/** Summarize the work performed, not the duration of the last model message. */
export function toolGroupSummary(steps: readonly { verb: string }[], locale: Locale): string {
  const counts = new Map<string, number>();
  for (const step of steps) counts.set(step.verb, (counts.get(step.verb) ?? 0) + 1);
  return [...counts].map(([operation, count]) =>
    translate(locale, "chat.toolGroupOperation", { operation, count }),
  ).join(" · ");
}
