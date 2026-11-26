import { afterAll, beforeEach, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";
import values from "../src/lib/appearance-values.json";
import { ACCENTS, accentPalette, appearanceTokens, normalizeContrast, normalizeHex, type Theme } from "../src/lib/appearance-colors";
import { applyAppearance, initAppearance, normalizeAppearance, readAppearance, saveModeAppearance, setThemeSetting } from "../src/lib/appearance";

// Execute only extracted pure color functions, not Codex or its initializers.
const evidence = readFileSync(new URL("./fixtures/codex-appearance-color-oracle.js", import.meta.url), "utf8");
const oracle = runInNewContext(`${evidence}
  qK=seeds; X2i=palettes; pK=swatches;
  rq={red:0,green:0,blue:0}; iq={red:255,green:255,blue:255};
  T4i={light:45,dark:60}; E4i=.7; D4i=2;
  O4i={dark:.16,light:.04}; k4i={dark:.0015,light:.0012};
  d4i=()=>false;
  ({palette:W2i, colors:(theme,contrast,accent)=>{
    const state=c4i({...seeds[theme],contrast,accent},theme);
    return {under:m4i(state.theme,state.surface,state.ink,theme),...(theme==='dark'?f4i(state):u4i(state))};
  }})`, { seeds: values.seeds, palettes: values.palettes, swatches: values.swatches }, { timeout: 1000 }) as {
  palette: (accent: string, theme: Theme) => Record<string, string>;
  colors: (theme: Theme, contrast: number, accent: string) => Record<string, string>;
};

test("accent values and Qone theme tokens match the extracted Codex functions", () => {
  const canonicalColor = (value: string) => value.replace(/^rgb\((\d+), (\d+), (\d+)\)$/, (_, r, g, b) => `#${[r, g, b].map((channel) => Number(channel).toString(16).padStart(2, "0")).join("")}`);
  for (const theme of ["light", "dark"] as const) for (const accent of ACCENTS.filter((value) => value !== "custom")) {
    const actual = accentPalette(accent, theme);
    const expected = oracle.palette(accent, theme);
    for (const key of ["accent", "text", "soft", "submitBackground", "submitText", "selection", "userMessageBackground", "userMessageText"] as const) expect(actual[key]).toBe(expected[key]);
    for (const contrast of [0, 1, 30, 45, 60, 75, 99, 100]) {
      const tokens = appearanceTokens(theme, contrast, accent);
      const expectedColors = oracle.colors(theme, contrast, actual.accent);
      expect(tokens["--background"]).toBe(expectedColors.under);
      expect(tokens["--muted"]).toBe(canonicalColor(expectedColors.controlBackgroundOpaque));
      expect(tokens["--popover"]).toBe(canonicalColor(expectedColors.elevatedPrimaryOpaque));
      expect(tokens["--border"]).toBe(expectedColors.border);
      expect(tokens["--muted-foreground"]).toBe(expectedColors.textForegroundSecondary);
      expect(tokens["--q-subtle"]).toBe(expectedColors.textForegroundTertiary);
      expect(tokens["--primary"]).toBe(expected.submitBackground);
      expect(tokens["--primary-foreground"]).toBe(expected.submitText);
      expect(tokens["--q-selection"]).toBe(expected.selection);
      expect(tokens["--q-user-message-background"]).toBe(expected.userMessageBackground);
      expect(tokens["--q-user-message-text"]).toBe(expected.userMessageText);
      // Hover/open surfaces must never take the accent tint.
      expect(tokens["--accent"]).toBe(tokens["--q-hover"]);
    }
  }
});

test("invalid persisted values, old named settings and custom colors normalize safely", () => {
  expect(normalizeAppearance(null, null).theme).toBe("system");
  expect(normalizeAppearance({ contrast: "enhanced", accent: "purple" }, "dark").light).toEqual({ contrast: 100, accent: "purple", customAccent: "#339cff" });
  expect(normalizeAppearance({ contrast: "reduced" }, "light").dark.contrast).toBe(0);
  expect(normalizeAppearance({ appearance: { light: { contrast: Infinity, accent: "invalid", customAccent: "url(invalid)" } } }, "invalid").light).toEqual({ contrast: null, accent: "default", customAccent: "#339cff" });
  expect(normalizeContrast(42.6, 60)).toBe(43);
  expect(normalizeContrast(-4, 60)).toBe(0);
  expect(normalizeContrast(104, 60)).toBe(100);
  expect(normalizeHex(" #AbCDEF ")).toBe("#abcdef");
  expect(accentPalette("custom", "dark", "#ffffff").submitText).toBe("#000000");
  expect(accentPalette("custom", "light", "#000000").submitText).toBe("#ffffff");
});

const originals = { window: Object.getOwnPropertyDescriptor(globalThis, "window"), document: Object.getOwnPropertyDescriptor(globalThis, "document") };
const storage = new Map<string, string>();
const style = new Map<string, string>();
const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => style.set(key, value), removeProperty: (key: string) => style.delete(key) } };
const media = Object.assign(new EventTarget(), { matches: true });
const reducedMotion = { matches: false };
const taskWindow = Object.assign(new EventTarget(), {
  innerWidth: 800,
  innerHeight: 600,
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  matchMedia: (query: string) => query === "(prefers-reduced-motion: reduce)" ? reducedMotion : media,
});
const taskDocument = { documentElement: root, startViewTransition: undefined as Document["startViewTransition"] | undefined };
const themeTrigger = { getBoundingClientRect: () => ({ left: 180, top: 280, width: 40, height: 40 }) } as HTMLElement;
beforeEach(() => {
  storage.clear(); style.clear(); root.dataset = {}; media.matches = true; reducedMotion.matches = false;
  taskDocument.startViewTransition = undefined;
  Object.defineProperty(globalThis, "window", { configurable: true, value: taskWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: taskDocument });
});
afterAll(() => {
  for (const key of ["window", "document"] as const) {
    if (originals[key]) Object.defineProperty(globalThis, key, originals[key]!);
    else Reflect.deleteProperty(globalThis, key);
  }
});

test("system mode survives runtime startup and follows changes until an explicit choice", () => {
  const dispose = initAppearance();
  expect(root.dataset.theme).toBe("dark");
  expect(storage.has("qone-theme")).toBe(false);
  media.matches = false; media.dispatchEvent(new Event("change"));
  expect(root.dataset.theme).toBe("light");
  setThemeSetting("dark");
  media.dispatchEvent(new Event("change"));
  expect(root.dataset.theme).toBe("dark");
  setThemeSetting("system");
  expect(root.dataset.theme).toBe("light");
  dispose();
});

test("theme reveal uses the trigger center, applies in the snapshot callback and clears after completion", async () => {
  applyAppearance();
  let update: (() => void) | undefined;
  const { promise: finished, resolve } = Promise.withResolvers<void>();
  taskDocument.startViewTransition = (callback) => {
    update = callback as () => void;
    return { ready: Promise.resolve(), finished } as ViewTransition;
  };

  setThemeSetting("light", themeTrigger);
  expect(root.dataset.theme).toBe("dark");
  expect(storage.has("qone-theme")).toBe(false);
  expect(style.get("--q-theme-reveal-from")).toBe("circle(0% at 25% 50%)");
  const radius = Number(style.get("--q-theme-reveal-to")?.match(/circle\(([\d.]+)% at 25% 50%\)/)?.[1]);
  expect(radius * Math.hypot(800, 600) / Math.SQRT2 / 100).toBeCloseTo(Math.hypot(600, 300));
  update!();
  expect(root.dataset.theme).toBe("light");
  expect(storage.get("qone-theme")).toBe("light");
  resolve();
  await finished;
  expect(root.dataset.themeReveal).toBeUndefined();
  expect(style.has("--q-theme-reveal-from")).toBe(false);
  expect(style.has("--q-theme-reveal-to")).toBe(false);
});

test("a new theme choice during a reveal wins over the skipped update", async () => {
  applyAppearance();
  const { promise: updateCallbackDone, resolve: updated } = Promise.withResolvers<void>();
  const { promise: ready, reject: skipped } = Promise.withResolvers<void>();
  const { promise: finished, resolve: finish } = Promise.withResolvers<void>();
  taskDocument.startViewTransition = (callback) => ({
    ready, finished, updateCallbackDone,
    skipTransition: () => {
      skipped(new DOMException("Skipped", "AbortError"));
      (callback as () => void)();
      updated();
      finish();
    },
  } as ViewTransition);
  setThemeSetting("light", themeTrigger);
  setThemeSetting("system", themeTrigger);
  await finished;
  expect(root.dataset.theme).toBe("dark");
  expect(storage.get("qone-theme")).toBe("system");
  expect(root.dataset.themeReveal).toBeUndefined();
});

test("theme settings apply immediately without animation support, with reduced motion or with no visual change", () => {
  applyAppearance();
  setThemeSetting("light", themeTrigger);
  expect(root.dataset.theme).toBe("light");
  taskDocument.startViewTransition = () => { throw new Error("Should not animate"); };
  reducedMotion.matches = true;
  setThemeSetting("dark", themeTrigger);
  expect(root.dataset.theme).toBe("dark");
  reducedMotion.matches = false;
  setThemeSetting("system", themeTrigger);
  expect(storage.get("qone-theme")).toBe("system");
  expect(root.dataset.theme).toBe("dark");
});

test("per-mode settings persist without dropping language or the other mode", () => {
  storage.set("qone-general-settings", JSON.stringify({ language: "en", unrelated: { preserved: true }, accent: "purple" }));
  saveModeAppearance("dark", { contrast: 87, accent: "yellow" });
  saveModeAppearance("light", { accent: "custom", customAccent: "#abCDef" });
  expect(readAppearance().dark).toEqual({ contrast: 87, accent: "yellow", customAccent: "#339cff" });
  expect(readAppearance().light.accent).toBe("custom");
  expect(readAppearance().light.customAccent).toBe("#abcdef");
  expect(JSON.parse(storage.get("qone-general-settings")!).language).toBe("en");
  expect(JSON.parse(storage.get("qone-general-settings")!).unrelated).toEqual({ preserved: true });
  saveModeAppearance("dark", { contrast: null });
  setThemeSetting("dark");
  expect(style.get("--muted")).toBe(appearanceTokens("dark", 60, "yellow")["--muted"]);
  setThemeSetting("light");
  expect(style.get("--ring")).toBe("#abcdef");
});

test("startup restores all appearance tokens before opening settings and external updates apply", () => {
  storage.set("qone-theme", "dark");
  storage.set("qone-general-settings", JSON.stringify({ appearance: { dark: { contrast: 99, accent: "green" } } }));
  const dispose = initAppearance();
  expect(root.dataset.accent).toBe("green");
  expect(style.get("--border")).toBe(appearanceTokens("dark", 99, "green")["--border"]);
  storage.set("qone-theme", "light");
  const event = Object.assign(new Event("storage"), { key: "qone-theme" });
  taskWindow.dispatchEvent(event);
  expect(root.dataset.theme).toBe("light");
  dispose();
  storage.set("qone-general-settings", "corrupted");
  applyAppearance();
  expect(root.dataset.accent).toBe("default");
});
