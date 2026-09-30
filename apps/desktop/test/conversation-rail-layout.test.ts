import { expect, test } from "bun:test";
import { hasConversationRailSpace, hasConversationRailSpaceInViewport } from "../src/lib/conversation-rail-layout";

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
