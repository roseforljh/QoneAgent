import { describe, expect, test } from "bun:test";
import {
  clampSidebarWidth, defaultSidebarWidth, parseSavedSidebarWidth,
  sidebarResizeState, sidebarWidthBounds,
} from "../src/lib/sidebar-layout";

describe("Codex sidebar geometry", () => {
  test("uses pixel preferences and reserves shell space without a dock feedback loop", () => {
    expect(defaultSidebarWidth(1200)).toBe(340);
    expect(sidebarWidthBounds(600)).toEqual({ minimum: 240, maximum: 360 });
    expect(clampSidebarWidth(400, 1200)).toBe(400);
    expect(clampSidebarWidth(400, 600)).toBe(360);
    expect(clampSidebarWidth(400, 1400)).toBe(400);
    expect(clampSidebarWidth(100, 1200)).toBe(240);
    expect(clampSidebarWidth(900, 1200)).toBe(520);
  });
  test("closes below half minimum, reverses within the same drag, keeps normal content width", () => {
    expect(sidebarResizeState(120, 1200)).toEqual({ open: true, width: 240 });
    expect(sidebarResizeState(119.9, 1200).open).toBe(false);
    expect(sidebarResizeState(-500, 1200).open).toBe(false);
    expect(sidebarResizeState(121, 1200)).toEqual({ open: true, width: 240 });
  });
  test("missing, obsolete ratio or corrupt storage cannot become zero width", () => {
    for (const value of [null, "", " ", "0", "0.5", "NaN", "Infinity", "-300"]) {
      expect(parseSavedSidebarWidth(value)).toBeUndefined();
    }
    expect(parseSavedSidebarWidth("400")).toBe(400);
    expect(parseSavedSidebarWidth("900")).toBe(520);
  });
});
