import { create } from "zustand";
import type { StateStorage } from "zustand/middleware";
import { DEFAULT_SIDEBAR_WIDTH, parseSavedSidebarWidth, SIDEBAR_WIDTH_STORAGE_KEY } from "./sidebar-layout";
import { DOCK_WIDTH_STORAGE_KEY, dockWidthFromRatio } from "./dock-layout";

export const DOCK_PIXEL_WIDTH_STORAGE_KEY = "qone:right-panel-width:px:v2";
type SizeStorage = Pick<StateStorage, "getItem" | "setItem">;

function localSizeStorage(): SizeStorage | undefined {
  try { return typeof window === "undefined" ? undefined : window.localStorage; }
  catch { return undefined; }
}

function read(storage: SizeStorage | undefined, key: string): string | null {
  try {
    const value = storage?.getItem(key);
    return typeof value === "string" ? value : null;
  } catch { return null; }
}

export function parseSavedDockWidth(value: string | null): number | undefined {
  if (value === null || value.trim() === "") return undefined;
  const width = Number(value);
  return Number.isFinite(width) && width > 0 ? Math.round(width) || undefined : undefined;
}

interface PaneSizes {
  sidebarWidth: number;
  dockWidth?: number;
  setSidebarWidth: (width: number) => void;
  setDockWidth: (width: number) => void;
  migrateDockWidth: (availableWidth: number, availableHeight: number, overlay: boolean) => void;
}

// One preference for every mounted pane. Container measurements only clamp the
// rendered size; they never replace the user's last explicitly chosen width.
export function createPaneSizesStore(storage = localSizeStorage()) {
  const legacy = read(storage, DOCK_WIDTH_STORAGE_KEY);
  const ratio = legacy === null || legacy.trim() === "" ? undefined : Number(legacy);
  const write = (key: string, width: number) => {
    try { void storage?.setItem(key, String(width)); }
    catch { /* The shared session preference remains available without storage. */ }
  };
  return create<PaneSizes>((set, get) => ({
    sidebarWidth: parseSavedSidebarWidth(read(storage, SIDEBAR_WIDTH_STORAGE_KEY)) ?? DEFAULT_SIDEBAR_WIDTH,
    dockWidth: parseSavedDockWidth(read(storage, DOCK_PIXEL_WIDTH_STORAGE_KEY)),
    setSidebarWidth: (width) => {
      const next = parseSavedSidebarWidth(String(width));
      if (next === undefined || next === get().sidebarWidth) return;
      write(SIDEBAR_WIDTH_STORAGE_KEY, next);
      set({ sidebarWidth: next });
    },
    setDockWidth: (width) => {
      const next = parseSavedDockWidth(String(width));
      if (next === undefined || next === get().dockWidth) return;
      write(DOCK_PIXEL_WIDTH_STORAGE_KEY, next);
      set({ dockWidth: next });
    },
    migrateDockWidth: (availableWidth, availableHeight, overlay) => {
      if (get().dockWidth !== undefined || ratio === undefined || !Number.isFinite(ratio)
        || ratio < 0 || ratio > 1 || availableWidth <= 0 || availableHeight <= 0) return;
      get().setDockWidth(dockWidthFromRatio(ratio, availableWidth, availableHeight, overlay));
    },
  }));
}

export const usePaneSizes = createPaneSizesStore();
