import { useMemo, useSyncExternalStore } from "react";
import { flushSync } from "react-dom";
import { GENERAL_SETTINGS_KEY, readGeneralSettings } from "../localization";
import { ACCENTS, appearanceTokens, normalizeContrast, normalizeHex, THEME_DEFAULTS, type Accent, type Theme } from "./appearance-colors";

export type ThemeSetting = Theme | "system";
export type ModeAppearance = { contrast: number | null; accent: Accent; customAccent: string };
export type Appearance = { theme: ThemeSetting; light: ModeAppearance; dark: ModeAppearance };
export const THEME_STORAGE_KEY = "qone-theme";
const CHANGE_EVENT = "qone-appearance-change";
const SYSTEM_QUERY = "(prefers-color-scheme: dark)";
let activeThemeReveal: ViewTransition | undefined;

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function normalizeAppearance(saved: unknown, savedTheme: unknown): Appearance {
  const general = object(saved);
  const appearance = object(general.appearance);
  function mode(theme: Theme): ModeAppearance {
    const settings = object(appearance[theme]);
    const accent = settings.accent ?? general.accent;
    const rawContrast = settings.contrast === undefined ? general.contrast : settings.contrast;
    // Preserve old choices; their old CSS had no numeric values, so use the
    // verified slider bounds for enhanced/reduced and null for mode defaults.
    const contrast = rawContrast === "enhanced" ? 100 : rawContrast === "reduced" ? 0
      : typeof rawContrast === "number" && Number.isFinite(rawContrast) ? normalizeContrast(rawContrast, THEME_DEFAULTS[theme].contrast) : null;
    return { contrast, accent: ACCENTS.includes(accent as Accent) ? accent as Accent : "default", customAccent: normalizeHex(settings.customAccent) };
  }
  return { theme: savedTheme === "light" || savedTheme === "dark" ? savedTheme : "system", light: mode("light"), dark: mode("dark") };
}
export function readAppearance(): Appearance {
  let savedTheme: string | null = null;
  try { savedTheme = window.localStorage.getItem(THEME_STORAGE_KEY); } catch { /* System fallback. */ }
  return normalizeAppearance(readGeneralSettings(), savedTheme);
}
export function resolveTheme(setting: ThemeSetting, systemDark: boolean): Theme {
  return setting === "system" ? systemDark ? "dark" : "light" : setting;
}
function systemDark() { return typeof window.matchMedia === "function" && window.matchMedia(SYSTEM_QUERY).matches; }
export function applyAppearance() {
  const appearance = readAppearance();
  const theme = resolveTheme(appearance.theme, systemDark());
  const settings = appearance[theme];
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.accent = settings.accent;
  delete root.dataset.contrast;
  for (const [key, value] of Object.entries(appearanceTokens(theme, settings.contrast ?? THEME_DEFAULTS[theme].contrast, settings.accent, settings.customAccent))) root.style.setProperty(key, value);
}
function notifyAppearance() {
  applyAppearance();
  window.dispatchEvent(new Event(CHANGE_EVENT));
}
export function setThemeSetting(theme: ThemeSetting, trigger?: HTMLElement | null) {
  if (!["system", "light", "dark"].includes(theme)) return;
  const apply = () => {
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
    notifyAppearance();
  };
  if (activeThemeReveal) {
    // The skipped transition's update still runs; apply the newer choice after it.
    activeThemeReveal.skipTransition();
    void activeThemeReveal.updateCallbackDone.then(apply, apply);
    return;
  }
  const root = document.documentElement;
  if (!trigger || !document.startViewTransition || window.matchMedia("(prefers-reduced-motion: reduce)").matches
    || root.dataset.theme === resolveTheme(theme, systemDark())) {
    apply();
    return;
  }

  const { left, top, width, height } = trigger.getBoundingClientRect();
  const { innerWidth, innerHeight } = window;
  const x = left + width / 2;
  const y = top + height / 2;
  const radius = Math.hypot(Math.max(x, innerWidth - x), Math.max(y, innerHeight - y));
  // Percentage coordinates keep the snapshot aligned on fractional display scales.
  const center = `${100 * x / innerWidth}% ${100 * y / innerHeight}%`;
  const radiusPercent = 100 * radius * Math.SQRT2 / Math.hypot(innerWidth, innerHeight);
  root.dataset.themeReveal = "";
  root.style.setProperty("--q-theme-reveal-from", `circle(0% at ${center})`);
  root.style.setProperty("--q-theme-reveal-to", `circle(${radiusPercent}% at ${center})`);
  const transition = document.startViewTransition(() => flushSync(apply));
  activeThemeReveal = transition;
  const cleanup = () => {
    activeThemeReveal = undefined;
    delete root.dataset.themeReveal;
    root.style.removeProperty("--q-theme-reveal-from");
    root.style.removeProperty("--q-theme-reveal-to");
  };
  void transition.ready.catch(() => {}); // A skipped reveal still applies the theme.
  void transition.finished.then(cleanup, cleanup);
}
export function saveModeAppearance(theme: Theme, patch: Partial<ModeAppearance>) {
  const current = readAppearance();
  const saved = readGeneralSettings();
  const next = normalizeAppearance({ appearance: { light: current.light, dark: current.dark, [theme]: { ...current[theme], ...patch } } }, current.theme);
  window.localStorage.setItem(GENERAL_SETTINGS_KEY, JSON.stringify({ ...saved, appearance: { light: next.light, dark: next.dark } }));
  notifyAppearance();
}
export function initAppearance() {
  const media = window.matchMedia(SYSTEM_QUERY);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === THEME_STORAGE_KEY || event.key === GENERAL_SETTINGS_KEY) notifyAppearance();
  };
  media.addEventListener("change", notifyAppearance);
  window.addEventListener("storage", onStorage);
  applyAppearance();
  return () => { media.removeEventListener("change", notifyAppearance); window.removeEventListener("storage", onStorage); };
}
function subscribe(onChange: () => void) {
  window.addEventListener(CHANGE_EVENT, onChange);
  return () => window.removeEventListener(CHANGE_EVENT, onChange);
}
function snapshot() { return JSON.stringify({ appearance: readAppearance(), systemDark: systemDark() }); }
export function useAppearance() {
  const state = useSyncExternalStore(subscribe, snapshot, snapshot);
  return useMemo(() => {
    const { appearance, systemDark: dark } = JSON.parse(state) as { appearance: Appearance; systemDark: boolean };
    const theme = resolveTheme(appearance.theme, dark);
    return { ...appearance, resolvedTheme: theme, current: appearance[theme], contrast: appearance[theme].contrast ?? THEME_DEFAULTS[theme].contrast };
  }, [state]);
}
