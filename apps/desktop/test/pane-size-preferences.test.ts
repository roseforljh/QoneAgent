import { describe, expect, test } from "bun:test";
import { createPaneSizesStore, DOCK_PIXEL_WIDTH_STORAGE_KEY } from "../src/lib/pane-size-preferences";

function memoryStorage(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    values,
  };
}

describe("pane size preferences", () => {
  test("restores explicit sidebar and dock widths across store instances", () => {
    const storage = memoryStorage();
    const first = createPaneSizesStore(storage);
    first.getState().setSidebarWidth(430);
    first.getState().setDockWidth(560);

    const restored = createPaneSizesStore(storage);
    expect(restored.getState().sidebarWidth).toBe(430);
    expect(restored.getState().dockWidth).toBe(560);
  });

  test("migrates the old dock ratio once and then keeps pixels", () => {
    const storage = memoryStorage({ "qone:right-panel-width:v1": "0.5" });
    const restored = createPaneSizesStore(storage);
    restored.getState().migrateDockWidth(1000, 800, false);
    expect(restored.getState().dockWidth).toBe(484);
    expect(storage.values.get(DOCK_PIXEL_WIDTH_STORAGE_KEY)).toBe("484");

    restored.getState().migrateDockWidth(800, 800, false);
    expect(restored.getState().dockWidth).toBe(484);
  });
});
