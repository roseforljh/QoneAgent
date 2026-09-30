import values from "./appearance-values.json";

export type Theme = "light" | "dark";
export const ACCENTS = ["default", "blue", "green", "yellow", "pink", "orange", "purple", "black", "custom"] as const;
export type Accent = typeof ACCENTS[number];
export const THEME_DEFAULTS = values.seeds;
type ChromaticAccent = Exclude<Accent, "default" | "black" | "custom">;
const palettes: Record<ChromaticAccent, Record<number, string>> = values.palettes;
type RGB = [number, number, number];
const black: RGB = [0, 0, 0];
const white: RGB = [255, 255, 255];
function rgb(hex: string): RGB { return [1, 3, 5].map((start) => parseInt(hex.slice(start, start + 2), 16)) as RGB; }
function mix(from: RGB, to: RGB, fraction: number): RGB {
  const amount = Math.min(1, Math.max(0, fraction));
  return from.map((channel, index) => Math.round(channel + (to[index] - channel) * amount)) as RGB;
}
function hex(color: RGB) { return `#${color.map((channel) => channel.toString(16).padStart(2, "0")).join("")}`; }
function alpha(color: RGB, opacity: number) {
  const amount = Math.min(1, Math.max(0, opacity)).toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
  return `rgba(${color.join(", ")}, ${amount})`;
}
export function normalizeContrast(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(100, Math.max(0, Math.round(value))) : fallback;
}
export function normalizeHex(value: unknown, fallback = "#339cff"): string {
  return typeof value === "string" && /^#[\da-f]{6}$/i.test(value.trim()) ? value.trim().toLowerCase() : fallback;
}

// Codex p4i: contrast is deliberately non-linear around each mode's default.
export function contrastFactor(value: number, theme: Theme) {
  const baseline = THEME_DEFAULTS[theme].contrast;
  const adjusted = value / 100 + (value - baseline) / 60 * 0.7;
  return value <= baseline ? adjusted : baseline / 100 + (adjusted - baseline / 100) * 2;
}

// Values/branches extracted from W2i/G2i, with a local custom-color option.
export function accentPalette(accent: Accent, theme: Theme, customAccent = "#339cff") {
  const dark = theme === "dark";
  if (accent === "custom") {
    const color = normalizeHex(customAccent);
    const channels = rgb(color);
    const luminance = channels.map((channel) => { const c = channel / 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; });
    const onColor = luminance[0] * 0.2126 + luminance[1] * 0.7152 + luminance[2] * 0.0722 > 0.179 ? "#000000" : "#ffffff";
    return { swatch: color, accent: color, text: color, soft: alpha(channels, 0.12), submitBackground: color, submitText: onColor, selection: alpha(channels, 0.35), userMessageBackground: "color-mix(in oklab, var(--foreground) 5%, transparent)", userMessageText: "var(--foreground)" };
  }
  const neutral = accent === "default" || accent === "black";
  const palette = palettes[neutral ? "blue" : accent];
  const textLevel = accent === "yellow" ? dark ? 400 : 600 : dark && (accent === "pink" || accent === "orange") ? 400 : 500;
  const submitBackground = neutral ? dark ? "#ffffff" : "#000000" : palette[dark && accent !== "pink" ? 500 : 400];
  return {
    swatch: neutral ? submitBackground : values.swatches[accent],
    accent: palette[accent === "purple" ? 300 : 400],
    text: palette[textLevel],
    soft: palette[dark ? 800 : 50],
    submitBackground,
    submitText: neutral && dark ? "#000000" : "#ffffff",
    userMessageBackground: accent === "black" && !dark ? "#000000" : neutral ? dark ? "rgb(50 50 50 / 85%)" : "rgb(233 233 233 / 50%)" : palette[dark ? 700 : 50],
    userMessageText: accent === "black" && !dark ? "#ffffff" : neutral ? dark ? "#ffffff" : "#0d0d0d" : palette[dark ? 25 : 900],
    selection: accent === "black" ? dark ? "#41414166" : "#afafaf66"
      : accent === "default" ? dark ? `${palette[200]}66` : `${palette[300]}59`
      : dark ? `${palette[400]}${accent === "yellow" ? "80" : "99"}` : `${palette[300]}59`,
  };
}

// Map Codex c4i/u4i/f4i/m4i/h4i values onto Qone's existing theme tokens.
export function appearanceTokens(theme: Theme, contrast: number, accent: Accent, customAccent?: string): Record<string, string> {
  const seed = THEME_DEFAULTS[theme];
  const ink = rgb(seed.ink);
  const surface = rgb(seed.surface);
  const contrastValue = normalizeContrast(contrast, seed.contrast);
  const factor = contrastFactor(contrastValue, theme);
  const dark = theme === "dark";
  const palette = accentPalette(accent, theme, customAccent);
  const control = hex(mix(surface, dark ? ink : white, dark ? 0.06 + factor * 0.05 : 0.09 + factor * 0.04));
  const elevated = hex(mix(surface, dark ? ink : white, dark ? 0.08 + factor * 0.08 : 0.16 + factor * 0.12));
  const under = hex(mix(surface, dark ? black : ink, (dark ? 0.16 : 0.04) + (contrastValue - seed.contrast) * (dark ? 0.0015 : 0.0012)));
  const hover = alpha(ink, dark ? 0.05 + factor * 0.03 : 0.08 + factor * 0.04);
  return {
    "--background": under,
    "--foreground": seed.ink,
    "--card": seed.surface,
    "--card-foreground": seed.ink,
    "--popover": elevated,
    "--popover-foreground": seed.ink,
    "--muted": control,
    "--muted-foreground": alpha(ink, 0.65 + factor * 0.1),
    "--secondary": control,
    "--secondary-foreground": seed.ink,
    "--accent": palette.soft,
    "--accent-foreground": palette.text,
    "--primary": palette.submitBackground,
    "--primary-foreground": palette.submitText,
    "--ring": palette.accent,
    "--border": alpha(ink, 0.06 + factor * 0.04),
    "--input": alpha(ink, 0.06 + factor * 0.04),
    "--q-bg": under,
    "--q-sidebar": seed.surface,
    "--q-surface": elevated,
    "--q-surface-muted": control,
    "--q-hover": hover,
    "--q-subtle": alpha(ink, dark ? 0.42 + factor * 0.13 : 0.45 + factor * 0.1),
    "--q-text": seed.ink,
    "--q-accent": palette.text,
    "--q-accent-color": palette.swatch,
    "--q-selection": palette.selection,
    "--q-user-message-background": palette.userMessageBackground,
    "--q-user-message-text": palette.userMessageText,
    "--q-composer-link-info": palette.text,
    "--q-composer-link-ink": seed.ink,
  };
}
