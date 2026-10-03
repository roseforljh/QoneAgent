import type { RuntimeEvent } from "@qone/protocol";

export function* runtimeEvents(payload: unknown): Generator<RuntimeEvent | { type: "runtime.exited" }> {
  const pending: unknown[] = [payload];
  while (pending.length) {
    const value = pending.pop();
    if (typeof value === "string") {
      try { pending.push(JSON.parse(value)); } catch { /* Ignore malformed transport data. */ }
    } else if (Array.isArray(value)) {
      for (let index = value.length - 1; index >= 0; index--) pending.push(value[index]);
    } else if (value && typeof value === "object" && typeof (value as { type?: unknown }).type === "string") {
      yield value as RuntimeEvent | { type: "runtime.exited" };
    }
  }
}
