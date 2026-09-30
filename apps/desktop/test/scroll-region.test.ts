import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindScrollRegion } from "../src/lib/scroll-region";

class ElementStub extends EventTarget {
  scrollTop = 0;
  scrollHeight = 800;
  clientHeight = 300;
  children = new Set<ElementStub>();
  calls: ScrollToOptions[] = [];
  wheelOptions: AddEventListenerOptions | boolean | undefined;
  ownerDocument = {
    defaultView: { getComputedStyle: () => ({ lineHeight: "24px", fontSize: "16px" }) },
  };
  contains(element: ElementStub) { return this.children.has(element); }
  scrollTo(options: ScrollToOptions) {
    this.calls.push(options);
    this.scrollTop = Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight));
    this.dispatchEvent(new Event("scroll"));
  }
  override addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: AddEventListenerOptions | boolean) {
    if (type === "wheel") this.wheelOptions = options;
    super.addEventListener(type, listener, options);
  }
  dom() { return this as unknown as HTMLElement; }
}

class WheelStub extends Event {
  deltaY: number;
  deltaX = 0;
  deltaMode = 0;
  ctrlKey = false;
  metaKey = false;
  shiftKey = false;
  constructor(deltaY: number, options: Partial<WheelStub> = {}, cancelable = true) {
    super("wheel", { cancelable });
    this.deltaY = deltaY;
    Object.assign(this, options);
  }
}

class ObserverStub {
  static instances: ObserverStub[] = [];
  observed = new Set<HTMLElement>();
  constructor(private callback: ResizeObserverCallback) { ObserverStub.instances.push(this); }
  observe(element: HTMLElement) { this.observed.add(element); }
  disconnect() { this.observed.clear(); }
  resize() { this.callback([], this as unknown as ResizeObserver); }
}

const originalObserver = globalThis.ResizeObserver;
let disposers: Array<() => void> = [];
beforeEach(() => {
  ObserverStub.instances = [];
  globalThis.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver;
});
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  globalThis.ResizeObserver = originalObserver;
});

function fixture({ top = 200, follow = false } = {}) {
  const inner = new ElementStub();
  const content = new ElementStub();
  const outer = new ElementStub();
  outer.scrollHeight = 2000;
  outer.clientHeight = 600;
  outer.scrollTop = 400;
  outer.children.add(inner);
  inner.scrollTop = top;
  let viewport: HTMLElement | null = outer.dom();
  let autoFollow = follow;
  let edges = { top: false, bottom: false };
  const dispose = bindScrollRegion(inner.dom(), content.dom(), {
    getViewport: () => viewport,
    autoFollow: () => autoFollow,
    onEdgesChange: (next) => { edges = next; },
  });
  disposers.push(dispose);
  return {
    inner, outer, content, dispose,
    observer: ObserverStub.instances.at(-1)!,
    wheel: (delta: number, options?: Partial<WheelStub>, cancelable?: boolean) => {
      const event = new WheelStub(delta, options, cancelable);
      inner.dispatchEvent(event);
      return event;
    },
    setViewport: (value: HTMLElement | null) => { viewport = value; },
    setAutoFollow: (value: boolean) => { autoFollow = value; },
    edges: () => edges,
  };
}

test("real wheel handler consumes inner distance only before the boundary", () => {
  const f = fixture();
  expect(f.inner.wheelOptions).toEqual({ passive: false });
  expect(f.wheel(60).defaultPrevented).toBe(true);
  expect(f.inner.scrollTop).toBe(260);
  expect(f.outer.calls).toHaveLength(0);
});

test("the gesture crossing the bottom immediately passes only its remainder to the viewport", () => {
  const f = fixture({ top: 480 });
  expect(f.wheel(60).defaultPrevented).toBe(true);
  expect(f.inner.scrollTop).toBe(500);
  expect(f.outer.scrollTop).toBe(440);
  expect(f.outer.calls).toEqual([{ top: 440, behavior: "instant" }]);
  expect(f.edges()).toEqual({ top: true, bottom: false });
});

test("continued wheel at the bottom scrolls the outer viewport without jumping to its end", () => {
  const f = fixture({ top: 500 });
  f.wheel(60);
  f.wheel(60);
  expect(f.inner.calls).toHaveLength(0);
  expect(f.outer.scrollTop).toBe(520);
  expect(f.outer.calls).toHaveLength(2);
});

test("an upward gesture crossing the top hands its remainder to the viewport", () => {
  const f = fixture({ top: 20 });
  f.wheel(-60);
  expect(f.inner.scrollTop).toBe(0);
  expect(f.outer.scrollTop).toBe(360);
});

test("short non-overflowing reasoning transfers the whole wheel gesture", () => {
  const f = fixture({ top: 0 });
  f.inner.scrollHeight = 200;
  expect(f.wheel(60).defaultPrevented).toBe(true);
  expect(f.outer.scrollTop).toBe(460);
});

test("upward scrolling outside a short region does not re-enable internal stream following", () => {
  const f = fixture({ top: 0, follow: true });
  f.inner.scrollHeight = 200;
  f.wheel(-60);
  expect(f.outer.scrollTop).toBe(340);
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.calls).toHaveLength(0);
});

test("fractional remaining distance is consumed rather than applied twice", () => {
  const f = fixture({ top: 499.5 });
  f.wheel(2);
  expect(f.inner.scrollTop).toBe(500);
  expect(f.outer.scrollTop).toBe(401.5);
});

test("an exact boundary hit consumes no outer distance; the next wheel scrolls externally", () => {
  const f = fixture({ top: 480 });
  f.wheel(20);
  expect(f.inner.scrollTop).toBe(500);
  expect(f.outer.calls).toHaveLength(0);
  f.wheel(20);
  expect(f.outer.scrollTop).toBe(420);
});

test("both regions at their boundary neither swallow input nor cause scrolling", () => {
  const f = fixture({ top: 500 });
  f.outer.scrollTop = 1400;
  expect(f.wheel(60).defaultPrevented).toBe(false);
  expect(f.outer.calls).toHaveLength(0);
  expect(f.inner.calls).toHaveLength(0);
});

test("line and page wheel units use measured line height and viewport height", () => {
  const f = fixture({ top: 500 });
  f.wheel(2, { deltaMode: 1 });
  expect(f.outer.scrollTop).toBe(448);
  f.wheel(1, { deltaMode: 2 });
  expect(f.outer.scrollTop).toBe(748);
});

test("viewport registration is resolved at event time, never via a CSS selector", () => {
  const f = fixture({ top: 500 });
  f.setViewport(null);
  expect(f.wheel(60).defaultPrevented).toBe(false);
  expect(f.outer.calls).toHaveLength(0);
  f.setViewport(f.outer.dom());
  expect(f.wheel(60).defaultPrevented).toBe(true);
  expect(f.outer.scrollTop).toBe(460);
});

test("zoom, horizontal, shift, non-cancelable and already-handled gestures remain native", () => {
  const f = fixture({ top: 500 });
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 100 }]) {
    expect(f.wheel(60, options).defaultPrevented).toBe(false);
  }
  expect(f.wheel(60, {}, false).defaultPrevented).toBe(false);
  const handled = new WheelStub(60);
  handled.preventDefault();
  f.inner.dispatchEvent(handled);
  expect(f.outer.calls).toHaveLength(0);
  expect(f.inner.calls).toHaveLength(0);
});

test("streamed growth follows internally but never hijacks the conversation position", () => {
  const f = fixture({ top: 500, follow: true });
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.scrollTop).toBe(600);
  expect(f.outer.calls).toHaveLength(0);
  expect(f.outer.scrollTop).toBe(400);
});

test("upward reading pauses following even before a scroll event or resize is delivered", () => {
  const f = fixture({ top: 500, follow: true });
  f.setViewport(null); // native wheel path: the browser has not delivered scroll yet
  f.wheel(-60);
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.calls).toHaveLength(0);
  expect(f.inner.scrollTop).toBe(500);
});

test("reading away from the bottom is retained, returning to bottom resumes streamed following", () => {
  const f = fixture({ top: 500, follow: true });
  f.wheel(-60);
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.scrollTop).toBe(440);
  f.wheel(160);
  expect(f.inner.scrollTop).toBe(600);
  f.inner.scrollHeight = 1000;
  f.observer.resize();
  expect(f.inner.scrollTop).toBe(700);
  expect(f.outer.calls).toHaveLength(0);
});

test("hidden or finished regions do not follow content growth", () => {
  const f = fixture({ top: 500, follow: true });
  f.inner.clientHeight = 0;
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.calls).toHaveLength(0);
  f.inner.clientHeight = 300;
  f.setAutoFollow(false);
  f.observer.resize();
  expect(f.inner.calls).toHaveLength(0);
});

test("disposing the actual binding removes listeners and disconnects observation", () => {
  const f = fixture({ top: 500 });
  expect(f.observer.observed.size).toBe(2);
  f.dispose();
  expect(f.observer.observed.size).toBe(0);
  expect(f.wheel(60).defaultPrevented).toBe(false);
  expect(f.outer.calls).toHaveLength(0);
});
