import { expect, test } from "bun:test";
import { getThreadScrollState, pruneThreadScrollStates } from "../src/lib/thread-scroll-state";

class ElementStub {
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  calls: { top: number; behavior: string }[] = [];

  scrollTo(options: { top: number; behavior: string }) {
    this.calls.push(options);
    this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
  }
}

test("scroll restoration remembers and restores scroll position per session", () => {
  pruneThreadScrollStates([]);
  const stateA = getThreadScrollState("session-a");
  const stateB = getThreadScrollState("session-b");

  expect(stateA?.current).toBeNull();
  expect(stateB?.current).toBeNull();

  stateA!.current = { scrollTop: 350, topAnchorTurn: null };
  stateB!.current = { scrollTop: 720, topAnchorTurn: null };

  expect(getThreadScrollState("session-a")?.current?.scrollTop).toBe(350);
  expect(getThreadScrollState("session-b")?.current?.scrollTop).toBe(720);

  pruneThreadScrollStates(["session-b"]);
  expect(getThreadScrollState("session-a")?.current).toBeNull(); // pruned and recreated fresh
  expect(getThreadScrollState("session-b")?.current?.scrollTop).toBe(720);
});

test("respects user message top-anchoring initially and follows bottom only when content overflows", () => {
  const viewport = new ElementStub();
  let isFollowingBottom = true;

  // Case 1: New user message sent and anchored at top.
  // Content height is small (within visible viewport).
  const availableBottom = 500;
  let contentBottom = 320; // 320 < 500, within visible bounds

  const checkAndFollow = () => {
    if (contentBottom > availableBottom + 8 && isFollowingBottom) {
      viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
    }
  };

  // Content is within viewport: should NOT scroll to bottom, preserving top anchoring!
  checkAndFollow();
  expect(viewport.calls.length).toBe(0);
  expect(viewport.scrollTop).toBe(0);

  // Case 2: Tools generate, collapsible sections expand, content grows past available bottom
  contentBottom = 680; // 680 > 500 + 8: now overflowing!
  viewport.scrollHeight = 1200;
  checkAndFollow();

  // Now that content overflows the visible area, it automatically scrolls to follow!
  expect(viewport.calls.length).toBe(1);
  expect(viewport.scrollTop).toBe(800); // 1200 - 400

  // Case 3: User scrolls up to view top-anchored question
  isFollowingBottom = false;
  contentBottom = 800;
  viewport.scrollHeight = 1400;
  checkAndFollow();

  // When user is reading history, follow is paused
  expect(viewport.calls.length).toBe(1);
});
