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
const root = { dataset: {} as Record<string, string>, style: { setProperty: (key: string, value: string) => style.set(key, value) } };
const media = Object.assign(new EventTarget(), { matches: true });
const taskWindow = Object.assign(new EventTarget(), {
  localStorage: { getItem: (key: string) => storage.get(key) ?? null, setItem: (key: string, value: string) => storage.set(key, value) },
  matchMedia: () => media,
});
beforeEach(() => {
  storage.clear(); style.clear(); root.dataset = {}; media.matches = true;
  Object.defineProperty(globalThis, "window", { configurable: true, value: taskWindow });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { documentElement: root } });
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
