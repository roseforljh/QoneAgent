import { expect, test } from "bun:test";
import { getThreadScrollState, pruneThreadScrollStates } from "../src/lib/thread-scroll-state";
import { shouldFollowThreadContent, userMessageRevealScrollTop } from "../src/components/assistant-ui/thread-scroll-follower";
import { mountThreadScrollController } from "../src/lib/thread-scroll-controller";

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

test("expanding a disclosure at the bottom keeps the animated content above the footer", () => {
  const originalElement = globalThis.Element;
  const originalResizeObserver = globalThis.ResizeObserver;
  const originalMutationObserver = globalThis.MutationObserver;
  const originalRequestAnimationFrame = globalThis.requestAnimationFrame;
  const originalCancelAnimationFrame = globalThis.cancelAnimationFrame;
  let resize: (() => void) | undefined;
  let frame: (() => void) | undefined;

  class NodeStub extends EventTarget {
    constructor(private readonly dataSlot?: string) { super(); }
    parentElement: NodeStub | null = null;
    scrollTop = 600;
    scrollHeight = 1000;
    clientHeight = 400;
    bottom = 500;
    top = 500;
    scrollTo({ top }: { top: number }) {
      this.scrollTop = Math.max(0, Math.min(top, this.scrollHeight - this.clientHeight));
    }
    getBoundingClientRect() {
      return { top: this.top, bottom: this.bottom, height: this.bottom - this.top } as DOMRect;
    }
    querySelector() { return null; }
    closest(selector: string) {
      return this.dataSlot && selector.includes(`data-slot="${this.dataSlot}"`) ? this : null;
    }
  }
  class ResizeObserverStub {
    constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as unknown as ResizeObserver); }
    observe() {}
    disconnect() {}
  }
  class MutationObserverStub {
    constructor() {}
    observe() {}
    disconnect() {}
  }

  try {
    globalThis.Element = NodeStub as unknown as typeof Element;
    globalThis.ResizeObserver = ResizeObserverStub as unknown as typeof ResizeObserver;
    globalThis.MutationObserver = MutationObserverStub as unknown as typeof MutationObserver;
    globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => { frame = () => callback(0); return 1; };
    globalThis.cancelAnimationFrame = () => { frame = undefined; };

    const viewport = new NodeStub();
    const content = new NodeStub();
    const footer = new NodeStub();
    const controller = mountThreadScrollController({
      viewport: viewport as unknown as HTMLElement,
      content: content as unknown as HTMLElement,
      footer: footer as unknown as HTMLElement,
      endContent: null,
      turn: { turnId: "turn-1", running: true, phase: "final_answer" },
      hasRestoration: true,
      onVisibility: () => {},
      onSave: () => {},
    });

    controller.scrollToBottom();
    const pointer = new Event("pointerdown");
    Object.defineProperty(pointer, "target", { configurable: true, value: new NodeStub("collapsible") });
    viewport.dispatchEvent(pointer);
    content.bottom = 700;
    viewport.scrollHeight = 1200;
    resize?.();
    frame?.();

    expect(viewport.scrollTop).toBe(800);
    controller.dispose();
  } finally {
    globalThis.Element = originalElement;
    globalThis.ResizeObserver = originalResizeObserver;
    globalThis.MutationObserver = originalMutationObserver;
    globalThis.requestAnimationFrame = originalRequestAnimationFrame;
    globalThis.cancelAnimationFrame = originalCancelAnimationFrame;
  }
});
