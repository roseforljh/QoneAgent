import { runtimeCopy } from "./runtime-copy";

export type RuntimeLocale = "en" | "zh-CN";
export type RuntimeMessageKey = keyof typeof runtimeCopy;
export interface LocalizedErrorInfo {
  code: RuntimeMessageKey;
  values?: Record<string, string | number>;
}

export function isRuntimeMessageKey(value: unknown): value is RuntimeMessageKey {
  return typeof value === "string" && Object.hasOwn(runtimeCopy, value);
}

export function runtimeMessage(locale: RuntimeLocale, code: RuntimeMessageKey, values?: Record<string, unknown>): string {
  return runtimeCopy[code][locale].replace(/\{(p\d+)\}/g, (placeholder, name: string) => String(values?.[name] ?? placeholder));
}
