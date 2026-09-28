// Values traced to Codex 26.924's right pane sizing. Keep them together so
// opening, resizing and restoring the pane use the same geometry.
const MIN_WIDTH = 320;
const MIN_MAIN_WIDTH = 352;
const DEFAULT_MAIN_WIDTH = 500;
const DEFAULT_MAX_WIDTH = 640;
const DEFAULT_HEIGHT_RATIO = 1.6;

export const DOCK_WIDTH_STORAGE_KEY = "qone:right-panel-width:v1";

export function dockWidthBounds(availableWidth: number, overlay: boolean) {
  const maximum = Math.max(0, Math.floor(overlay ? availableWidth : availableWidth - MIN_MAIN_WIDTH));
  return { minimum: Math.min(MIN_WIDTH, maximum), maximum };
}

export function defaultDockWidth(availableWidth: number, availableHeight: number, overlay: boolean) {
  const { minimum, maximum } = dockWidthBounds(availableWidth, overlay);
  const preferred = Math.max(
    MIN_WIDTH,
    Math.min(availableHeight * DEFAULT_HEIGHT_RATIO, availableWidth - DEFAULT_MAIN_WIDTH),
    Math.min(DEFAULT_MAX_WIDTH, availableWidth - MIN_MAIN_WIDTH),
  );
  return Math.round(Math.min(maximum, Math.max(minimum, preferred)));
}

export function clampDockWidth(width: number, availableWidth: number, overlay: boolean) {
  const { minimum, maximum } = dockWidthBounds(availableWidth, overlay);
  return Math.round(Math.min(maximum, Math.max(minimum, width)));
}

export function dockWidthFromRatio(ratio: number | undefined, availableWidth: number, availableHeight: number, overlay: boolean) {
  if (ratio === undefined || !Number.isFinite(ratio) || ratio < 0 || ratio > 1) {
    return defaultDockWidth(availableWidth, availableHeight, overlay);
  }
  const { minimum, maximum } = dockWidthBounds(availableWidth, overlay);
  return Math.round(minimum + ratio * (maximum - minimum));
}

export function dockWidthRatio(width: number, availableWidth: number, overlay: boolean) {
  const { minimum, maximum } = dockWidthBounds(availableWidth, overlay);
  return maximum === minimum ? 0 : (clampDockWidth(width, availableWidth, overlay) - minimum) / (maximum - minimum);
}
