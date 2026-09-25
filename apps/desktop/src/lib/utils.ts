import { twMerge, type ClassNameValue } from "tailwind-merge";
import type { Locale } from "../localization";

export type ClassValue = ClassNameValue;

export function cn(...inputs: ClassValue[]) {
  return twMerge(...inputs);
}

/** Human duration up to days: "45秒", "31分50秒", "2小时3分", "1天2小时". */
export function formatDuration(totalSeconds: number, locale: Locale): string {
  const seconds = Math.max(0, Math.round(totalSeconds));
  const zh = locale === "zh-CN";
  const units: [number, string][] = zh
    ? [[86400, "天"], [3600, "小时"], [60, "分"], [1, "秒"]]
    : [[86400, "d"], [3600, "h"], [60, "m"], [1, "s"]];
  const parts: string[] = [];
  let rest = seconds;
  for (const [size, label] of units) {
    if (rest < size) continue;
    const value = Math.floor(rest / size);
    rest %= size;
    parts.push(zh ? `${value}${label}` : `${value}${label}`);
    if (parts.length === 2) break;
  }
  const out = parts.join(zh ? "" : " ");
  return out || (zh ? "0秒" : "0s");
}
