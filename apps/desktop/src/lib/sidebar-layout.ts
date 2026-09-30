// Codex 26.928.2636: DS, SS and sidebar-width in app-initial.
export const MIN_SIDEBAR_WIDTH = 240;
export const DEFAULT_SIDEBAR_WIDTH = 340;
const MAX_SIDEBAR_WIDTH = 520;
const MIN_MAIN_WIDTH = 240;
export const SIDEBAR_WIDTH_STORAGE_KEY = "qone:left-sidebar-width:px:v2";
export const NARROW_SCREEN_WIDTH = 960;

export function sidebarWidthBounds(shellWidth: number) {
  return {
    minimum: MIN_SIDEBAR_WIDTH,
    maximum: Math.max(MIN_SIDEBAR_WIDTH, Math.min(MAX_SIDEBAR_WIDTH, shellWidth - MIN_MAIN_WIDTH)),
  };
}

export function clampSidebarWidth(width: number, shellWidth: number) {
  const { minimum, maximum } = sidebarWidthBounds(shellWidth);
  return Math.min(maximum, Math.max(minimum, Number.isFinite(width) ? width : DEFAULT_SIDEBAR_WIDTH));
}

export function defaultSidebarWidth(shellWidth: number) {
  return clampSidebarWidth(DEFAULT_SIDEBAR_WIDTH, shellWidth);
}

export function sidebarResizeState(rawWidth: number, shellWidth: number) {
  return { open: rawWidth >= MIN_SIDEBAR_WIDTH / 2, width: clampSidebarWidth(rawWidth, shellWidth) };
}

export function parseSavedSidebarWidth(value: string | null) {
  if (value === null || value.trim() === "") return undefined;
  const width = Number(value);
  return Number.isFinite(width) && width >= MIN_SIDEBAR_WIDTH ? clampSidebarWidth(width, Infinity) : undefined;
}

export function readSavedSidebarWidth() {
  if (typeof window === "undefined") return undefined;
  try { return parseSavedSidebarWidth(window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY)); }
  catch { return undefined; }
}
