import { expect, test } from "bun:test";
import { hasConversationRailSpace, hasConversationRailSpaceInViewport, measureConversationRail } from "../src/lib/conversation-rail-layout";

test("rail measurement preserves active and visible turns through gaps and shared turn ids", () => {
  const blocks = Array.from({ length: 200 }, (_, index) => ({
    dataset: { turnId: `turn-${Math.floor(index / 2)}` },
    getBoundingClientRect: () => ({ top: index * 80, bottom: index * 80 + 60 }),
  }));
  for (const top of [-90, 0, 55, 65, 390, 8010, 16000]) {
    const view = { top, bottom: top + 240 };
    for (const line of [view.top + 1, view.top + 120, view.bottom + 1]) {
      let activeId: string | undefined;
      let firstId: string | undefined;
      const visibleIds: string[] = [];
      for (const block of blocks) {
        const box = block.getBoundingClientRect();
        if (box.top >= view.bottom) break;
        firstId ??= block.dataset.turnId;
        if (box.top <= line) activeId = block.dataset.turnId;
        if (box.bottom > view.top && !visibleIds.includes(block.dataset.turnId)) visibleIds.push(block.dataset.turnId);
      }
      expect(measureConversationRail(blocks, view, line)).toEqual({ activeId: activeId ?? firstId, visibleIds });
    }
  }
  expect(measureConversationRail([], { top: 0, bottom: 100 }, 1)).toEqual({ activeId: undefined, visibleIds: [] });
});

test("a long conversation only measures search boundaries instead of all earlier turns", () => {
  const count = 10_000;
  let measurements = 0;
  const blocks = Array.from({ length: count }, (_, index) => ({
    dataset: { turnId: String(index) },
    getBoundingClientRect: () => { measurements++; return { top: index * 100, bottom: (index + 1) * 100 }; },
  }));
  expect(measureConversationRail(blocks, { top: 900_000, bottom: 900_500 }, 900_001)).toEqual({
    activeId: "9000", visibleIds: ["9000", "9001", "9002", "9003", "9004"],
  });
  expect(measurements).toBeLessThanOrEqual(3 * Math.ceil(Math.log2(count)) + 5);
});

test("navigation visibility uses 48 CSS pixels of measured gutter at every zoom", () => {
  expect(hasConversationRailSpace(undefined, 1000, 1000)).toBe(false);
  expect(hasConversationRailSpace(47.9, 1000, 1000)).toBe(false);
  expect(hasConversationRailSpace(48, 1000, 1000)).toBe(true);
  expect(hasConversationRailSpace(71.9, 1500, 1000)).toBe(false);
  expect(hasConversationRailSpace(72, 1500, 1000)).toBe(true);
  expect(hasConversationRailSpace(24, 500, 1000)).toBe(true);
});

const rect = (left: number, width: number): DOMRect => ({
  left, right: left + width, width, x: left, top: 0, bottom: 600, height: 600, y: 0,
  toJSON: () => ({}),
});

test("visibility measures the fixed column even when a user bubble has ample left space", () => {
  let columnLeft = 131;
  const queried: string[] = [];
  const viewport = {
    offsetWidth: 800,
    getBoundingClientRect: () => rect(100, 800),
    querySelector: (selector: string) => {
      queried.push(selector);
      return { getBoundingClientRect: () => selector === "[data-conversation-rail-content]" ? rect(columnLeft, 700) : rect(500, 300) };
    },
  };
  expect(hasConversationRailSpaceInViewport(viewport)).toBe(false);
  columnLeft = 148;
  expect(hasConversationRailSpaceInViewport(viewport)).toBe(true);
  expect(queried).toEqual(["[data-conversation-rail-content]", "[data-conversation-rail-content]"]);
});

test("sidebar changes and zoom use live column bounds on the chosen side", () => {
  let columnLeft = 172;
  const viewport = {
    offsetWidth: 800,
    getBoundingClientRect: () => rect(100, 1200),
    querySelector: () => ({ getBoundingClientRect: () => rect(columnLeft, 1056) }),
  };
  expect(hasConversationRailSpaceInViewport(viewport)).toBe(true);
  expect(hasConversationRailSpaceInViewport(viewport, "right")).toBe(true);
  columnLeft = 171;
  expect(hasConversationRailSpaceInViewport(viewport)).toBe(false);
  expect(hasConversationRailSpaceInViewport(viewport, "right")).toBe(true);
  columnLeft = 173;
  expect(hasConversationRailSpaceInViewport(viewport, "right")).toBe(false);
});

test("unavailable or unlaid-out content keeps the rail unmounted", () => {
  const viewport = { offsetWidth: 800, getBoundingClientRect: () => rect(0, 800), querySelector: () => null };
  expect(hasConversationRailSpaceInViewport(viewport)).toBe(false);
  expect(hasConversationRailSpaceInViewport({ ...viewport, querySelector: () => ({ getBoundingClientRect: () => rect(100, 0) }) })).toBe(false);
  expect(hasConversationRailSpaceInViewport({ ...viewport, getBoundingClientRect: () => rect(0, 0), querySelector: () => ({ getBoundingClientRect: () => rect(100, 700) }) })).toBe(false);
});
