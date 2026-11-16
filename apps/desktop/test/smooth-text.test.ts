import { expect, test } from "bun:test";
import { nextSmoothText } from "../src/lib/use-smooth-text";

test("smooth reveal catches up with a backlog quickly and never splits an emoji", () => {
  const goal = "x".repeat(1000);
  // One 16ms frame reveals a proportional slice, so a large backlog cannot lag far behind.
  expect(nextSmoothText("", goal, 16).length).toBe(64);
  let shown = "";
  for (let frame = 0; frame < 16; frame++) shown = nextSmoothText(shown, goal, 16);
  expect(shown.length).toBeGreaterThan(600);
  for (let frame = 0; frame < 60 && shown !== goal; frame++) shown = nextSmoothText(shown, goal, 16);
  expect(shown).toBe(goal);
  // A short tail still moves at least one char per frame.
  expect(nextSmoothText("ab", "abc", 1)).toBe("abc");
  // Replaced text jumps instead of animating from a stale prefix.
  expect(nextSmoothText("old", "new text", 16)).toBe("new text");
  const emoji = "a😀b";
  expect(nextSmoothText("a", emoji, 1)).toBe("a😀");
});
