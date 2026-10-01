export type LanguageSetting = "auto" | "zh-CN" | "en";
export type Locale = "zh-CN" | "en";
export const GENERAL_SETTINGS_KEY = "qone-general-settings";

export function resolveLocale(
  setting: LanguageSetting,
  languages: readonly string[] = typeof navigator === "undefined" ? [] : navigator.languages?.length ? navigator.languages : [navigator.language],
): Locale {
  if (setting !== "auto") return setting;
  for (const language of languages) {
    if (/^zh(?:[-_]|$)/i.test(language)) return "zh-CN";
    if (/^en(?:[-_]|$)/i.test(language)) return "en";
  }
  return "en";
}

export function normalizeLanguageSetting(language: unknown): LanguageSetting {
  return language === "en" || language === "zh-CN" ? language : "auto";
}
