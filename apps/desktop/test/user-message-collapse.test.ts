import { expect, test } from "bun:test";
import { USER_MESSAGE_COLLAPSED_LINES, userMessageNeedsCollapse } from "../src/components/assistant-ui/user-message";

test("only text taller than the Codex line budget collapses", () => {
  const line = 21;
  expect(userMessageNeedsCollapse(line * USER_MESSAGE_COLLAPSED_LINES, line)).toBe(false);
  expect(userMessageNeedsCollapse(line * USER_MESSAGE_COLLAPSED_LINES + 1, line)).toBe(false);
  expect(userMessageNeedsCollapse(line * (USER_MESSAGE_COLLAPSED_LINES + 1), line)).toBe(true);
  // A hidden/unmeasured box reports no usable line height and must stay open.
  expect(userMessageNeedsCollapse(5000, 0)).toBe(false);
  expect(userMessageNeedsCollapse(5000, 21, 3)).toBe(true);
});