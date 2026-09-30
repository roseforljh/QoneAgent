import { expect, test } from "bun:test";
import { getThreadScrollState, pruneThreadScrollStates } from "../src/lib/thread-scroll-state";
import { shouldFollowThreadContent, userMessageRevealScrollTop } from "../src/components/assistant-ui/thread-scroll-follower";

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

test("new turn stays at its user bubble while content grows, then follows after explicit bottom navigation", () => {
  const viewport = new ElementStub();
  const availableBottom = 500;
  expect(shouldFollowThreadContent(true, true, true, 680, availableBottom)).toBe(false);
  expect(shouldFollowThreadContent(true, false, true, 680, availableBottom)).toBe(false);
  expect(viewport.calls).toHaveLength(0);

  expect(shouldFollowThreadContent(true, true, false, 320, availableBottom)).toBe(false);
  expect(shouldFollowThreadContent(true, true, false, 680, availableBottom)).toBe(true);
  viewport.scrollHeight = 1200;
  viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
  expect(viewport.scrollTop).toBe(800);
  expect(shouldFollowThreadContent(true, false, false, 800, availableBottom)).toBe(false);
  expect(shouldFollowThreadContent(false, true, false, 800, availableBottom)).toBe(false);
});

test("a newly sent user message is revealed above the composer in a narrowed chat", () => {
  expect(userMessageRevealScrollTop(700, 480, 540, 100, 450)).toBe(790);
  expect(userMessageRevealScrollTop(700, 280, 340, 100, 450)).toBeNull();
  expect(userMessageRevealScrollTop(700, 40, 90, 100, 450)).toBe(640);
  expect(userMessageRevealScrollTop(700, 480, 900, 100, 450)).toBe(1080);
});
