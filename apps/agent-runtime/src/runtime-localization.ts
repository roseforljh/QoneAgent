import { AsyncLocalStorage } from "node:async_hooks";
import { runtimeMessage, isRuntimeMessageKey, type RuntimeLocale, type RuntimeMessageKey, type LocalizedErrorInfo } from "@qone/protocol";

const languageContext = new AsyncLocalStorage<RuntimeLocale>();
// Clients predating the locale field received Chinese; preserve that contract.
const legacyLocale: RuntimeLocale = "zh-CN";

/** Per-command context propagates through tools, child runs and continuations. */
export function withRuntimeLocale<T>(locale: RuntimeLocale | undefined, work: () => T): T {
  return languageContext.run(locale ?? legacyLocale, work);
}

export function runtimeText(code: RuntimeMessageKey, values?: Record<string, unknown>): string {
  return runtimeMessage(languageContext.getStore() ?? legacyLocale, code, values);
}

export class LocalizedRuntimeError extends Error implements LocalizedErrorInfo {
  readonly values: Record<string, string | number>;
  constructor(readonly code: RuntimeMessageKey, values: Record<string, unknown> = {}, options?: ErrorOptions) {
    super(runtimeText(code, values), options);
    this.values = Object.fromEntries(Object.entries(values).map(([key, value]) => [key, typeof value === "number" ? value : String(value)]));
  }
}

export function runtimeError(code: RuntimeMessageKey, values?: Record<string, unknown>, options?: ErrorOptions): LocalizedRuntimeError {
  return new LocalizedRuntimeError(code, values, options);
}

export function runtimeErrorInfo(error: unknown): { message: string; localization?: LocalizedErrorInfo } {
  const record = error && typeof error === "object" ? error as Partial<LocalizedErrorInfo> : undefined;
  const localization = record && isRuntimeMessageKey(record.code) ? { code: record.code, values: record.values } : undefined;
  return {
    message: error instanceof LocalizedRuntimeError ? error.message : localization ? runtimeText(localization.code, localization.values) : error instanceof Error ? error.message : String(error),
    ...(localization ? { localization } : {}),
  };
}
