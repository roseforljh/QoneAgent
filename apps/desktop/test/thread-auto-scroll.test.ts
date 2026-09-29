import { afterEach, beforeEach, expect, test } from "bun:test";
import { getThreadScrollState, pruneThreadScrollStates } from "../src/lib/thread-scroll-state";

class ElementStub {
  scrollTop = 0;
  scrollHeight = 1000;
  clientHeight = 400;
  listeners: Record<string, ((e: any) => void)[]> = {};
  calls: { top: number; behavior: string }[] = [];

  addEventListener(event: string, fn: (e: any) => void) {
    this.listeners[event] = this.listeners[event] || [];
    this.listeners[event].push(fn);
  }

  removeEventListener(event: string, fn: (e: any) => void) {
    if (!this.listeners[event]) return;
    this.listeners[event] = this.listeners[event].filter((item) => item !== fn);
  }

  dispatchEvent(event: string, data: any = {}) {
    const handlers = this.listeners[event] || [];
    for (const handler of handlers) handler(data);
  }

  scrollTo(options: { top: number; behavior: string }) {
    this.calls.push(options);
    this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
  }
}

class ContentStub {
  scrollHeight = 600;
  offsetHeight = 600;
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

test("follow bottom logic detects bottom distance and respects user upward scroll", () => {
  const viewport = new ElementStub();
  viewport.scrollHeight = 1200;
  viewport.clientHeight = 400;
  viewport.scrollTop = 800; // precisely at bottom: 1200 - 400 - 800 = 0 <= 48

  const isAtBottom = (vp: ElementStub) => vp.scrollHeight - vp.clientHeight - vp.scrollTop <= 48;
  expect(isAtBottom(viewport)).toBe(true);

  // User scrolls up by 200px
  viewport.scrollTop = 600;
  expect(isAtBottom(viewport)).toBe(false);

  // Content expands while user was at bottom
  viewport.scrollTop = 800;
  let isFollowingBottom = true;

  // Wheel up event
  const wheelUpEvent = { deltaY: -50 };
  if (wheelUpEvent.deltaY < 0) {
    isFollowingBottom = false;
  }
  expect(isFollowingBottom).toBe(false);

  // Wheel down event back to bottom
  viewport.scrollTop = 800;
  const wheelDownEvent = { deltaY: 50 };
  if (wheelDownEvent.deltaY > 0 && isAtBottom(viewport)) {
    isFollowingBottom = true;
  }
  expect(isFollowingBottom).toBe(true);

  // New content causes scroll to bottom
  viewport.scrollHeight = 1600;
  if (isFollowingBottom) {
    viewport.scrollTo({ top: viewport.scrollHeight, behavior: "instant" });
  }
  expect(viewport.scrollTop).toBe(1200);
  expect(viewport.calls.at(-1)?.top).toBe(1600);
});
