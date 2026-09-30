import { expect, test } from "bun:test";
import { clampDockWidth, defaultDockWidth, dockWidthBounds, dockWidthFromRatio, dockWidthRatio } from "../src/lib/dock-layout";

test("right pane retains room for the chat and follows its measured container", () => {
  expect(defaultDockWidth(1125, 800, false)).toBe(640);
  expect(defaultDockWidth(800, 800, false)).toBe(448);
  expect(dockWidthBounds(800, false)).toEqual({ minimum: 320, maximum: 448 });
  expect(clampDockWidth(700, 800, false)).toBe(448);
  expect(dockWidthBounds(280, true)).toEqual({ minimum: 320, maximum: 320 });
});

test("resized width can be restored after a container resize", () => {
  const ratio = dockWidthRatio(500, 1000, false);
  expect(dockWidthFromRatio(ratio, 1000, 800, false)).toBe(500);
  expect(dockWidthFromRatio(ratio, 800, 800, false)).toBe(390);
  expect(dockWidthFromRatio(Number.NaN, 800, 800, false)).toBe(defaultDockWidth(800, 800, false));
});
