import { useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { en } from "./i18n/en";
import { zh, type MessageKey } from "./i18n/zh-CN";
import { GENERAL_SETTINGS_KEY, normalizeLanguageSetting, resolveLocale, type LanguageSetting, type Locale } from "./locale-core";

export type { MessageKey } from "./i18n/zh-CN";
export { GENERAL_SETTINGS_KEY, resolveLocale } from "./locale-core";
export type { LanguageSetting, Locale } from "./locale-core";
export type LocalizedMessage = { key: MessageKey; values?: Record<string, string | number> };

const LANGUAGE_EVENT = "qone-language-change";
// A denied storage write must not prevent language switching in this window.
const unsavedLanguages = new WeakMap<Window, LanguageSetting>();

export function readGeneralSettings(): Record<string, unknown> {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(GENERAL_SETTINGS_KEY) ?? "{}");
    return saved && typeof saved === "object" && !Array.isArray(saved) ? saved as Record<string, unknown> : {};
  } catch { return {}; }
}

export function getLanguageSetting(): LanguageSetting {
  const unsaved = typeof window === "undefined" ? undefined : unsavedLanguages.get(window);
  if (unsaved) return unsaved;
  const { language } = readGeneralSettings();
  return normalizeLanguageSetting(language);
}

export function applyLocale() {
  document.documentElement.lang = resolveLocale(getLanguageSetting());
  if ((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__) {
    void invoke("set_native_copy", { copy: {
      show: translateCurrent("native.show"), quit: translateCurrent("native.quit"), completed: translateCurrent("native.completed"),
    } }).catch((error) => console.warn("Failed to synchronize native language", error));
  }
}

export function subscribeLanguage(onChange: () => void) {
  window.addEventListener(LANGUAGE_EVENT, onChange);
  window.addEventListener("languagechange", onChange);
  const onStorage = (event: StorageEvent) => {
    if (event.key === GENERAL_SETTINGS_KEY || event.key === null) {
      unsavedLanguages.delete(window);
      onChange();
    }
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
  try {
    window.localStorage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ ...readGeneralSettings(), language }));
    unsavedLanguages.delete(window);
  } catch {
    unsavedLanguages.set(window, language);
  }
  applyLocale();
  window.dispatchEvent(new Event(LANGUAGE_EVENT));
}

export function translate(locale: Locale, key: MessageKey, values?: Record<string, string | number>): string {
  const message = (locale === "en" ? en : zh)[key];
  return message.replace(/\{(\w+)\}/g, (placeholder, name: string) => String(values?.[name] ?? placeholder));
}

/** Resolve at call time so adapters and store actions follow the current setting. */
export function translateCurrent(key: MessageKey, values?: Record<string, string | number>): string {
  return translate(resolveLocale(getLanguageSetting()), key, values);
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
