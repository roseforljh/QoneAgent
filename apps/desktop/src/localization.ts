import { useSyncExternalStore } from "react";
import { en } from "./i18n/en";
import { zh, type MessageKey } from "./i18n/zh-CN";

export type { MessageKey } from "./i18n/zh-CN";
export type LanguageSetting = "auto" | "zh-CN" | "en";
export type Locale = "zh-CN" | "en";
export type LocalizedMessage = { key: MessageKey; values?: Record<string, string | number> };

export const GENERAL_SETTINGS_KEY = "qone-general-settings";
const LANGUAGE_EVENT = "qone-language-change";

export function readGeneralSettings(): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(GENERAL_SETTINGS_KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  } catch { return {}; }
}

export function getLanguageSetting(): LanguageSetting {
  const { language } = readGeneralSettings();
  return language === "en" || language === "zh-CN" ? language : "auto";
}

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

export function applyLocale() {
  document.documentElement.lang = resolveLocale(getLanguageSetting());
}

export function subscribeLanguage(onChange: () => void) {
  window.addEventListener(LANGUAGE_EVENT, onChange);
  window.addEventListener("languagechange", onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === GENERAL_SETTINGS_KEY || event.key === null) onChange();
  };
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(LANGUAGE_EVENT, onChange);
    window.removeEventListener("languagechange", onChange);
    window.removeEventListener("storage", onStorage);
  };
}

// Run before rendering so restored language applies even when Settings is closed.
export function initLocale() {
  applyLocale();
  return subscribeLanguage(applyLocale);
}

export function saveLanguageSetting(language: LanguageSetting) {
  window.localStorage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ ...readGeneralSettings(), language }));
  applyLocale();
  window.dispatchEvent(new Event(LANGUAGE_EVENT));
}

export function translate(locale: Locale, key: MessageKey, values?: Record<string, string | number>): string {
  const message = (locale === "en" ? en : zh)[key];
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => String(values?.[name] ?? placeholder));
}

const translators = {
  en: (key: MessageKey, values?: Record<string, string | number>) => translate("en", key, values),
  "zh-CN": (key: MessageKey, values?: Record<string, string | number>) => translate("zh-CN", key, values),
};

function getSnapshot() {
  const setting = getLanguageSetting();
  return `${setting}:${resolveLocale(setting)}` as const;
}

export function useLocale() {
  const snapshot = useSyncExternalStore(subscribeLanguage, getSnapshot, getSnapshot);
  const [languageSetting, locale] = snapshot.split(":") as [LanguageSetting, Locale];
  return { locale, languageSetting, t: translators[locale] };
}
