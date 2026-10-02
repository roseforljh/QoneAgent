import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindScrollRegion } from "../src/lib/scroll-region";

class ElementStub extends EventTarget {
  scrollTop = 0;
  scrollHeight = 800;
  clientHeight = 300;
  calls: ScrollToOptions[] = [];
  wheelOptions: AddEventListenerOptions | boolean | undefined;
  scrollTo(options: ScrollToOptions) {
    this.calls.push(options);
    this.nativeScroll(Math.max(0, Math.min(options.top ?? this.scrollTop, this.scrollHeight - this.clientHeight)));
  }
  nativeScroll(top: number) {
    this.scrollTop = top;
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
const originalRequest = globalThis.requestAnimationFrame;
const originalCancel = globalThis.cancelAnimationFrame;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let disposers: Array<() => void> = [];
beforeEach(() => {
  ObserverStub.instances = [];
  globalThis.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver;
  globalThis.requestAnimationFrame = (callback) => {
    frames.set(++nextFrame, callback);
    return nextFrame;
  };
  globalThis.cancelAnimationFrame = (id) => { frames.delete(id); };
});
afterEach(() => {
  for (const dispose of disposers) dispose();
  disposers = [];
  frames.clear();
  globalThis.ResizeObserver = originalObserver;
  globalThis.requestAnimationFrame = originalRequest;
  globalThis.cancelAnimationFrame = originalCancel;
});

function flushFrame() {
  const pending = [...frames.values()];
  frames.clear();
  for (const callback of pending) callback(0);
}

function fixture({ top = 200, follow = false } = {}) {
  const inner = new ElementStub();
  const content = new ElementStub();
  inner.scrollTop = top;
  let autoFollow = follow;
  const edges: Array<{ top: boolean; bottom: boolean }> = [];
  const dispose = bindScrollRegion(inner.dom(), content.dom(), {
    autoFollow: () => autoFollow,
    onEdgesChange: (next) => { edges.push(next); },
  });
  disposers.push(dispose);
  return {
    inner, dispose, edges,
    observer: ObserverStub.instances.at(-1)!,
    wheel: (delta: number, options?: Partial<WheelStub>, cancelable?: boolean) => {
      const event = new WheelStub(delta, options, cancelable);
      inner.dispatchEvent(event);
      return event;
    },
    setAutoFollow: (value: boolean) => { autoFollow = value; },
  };
}

test("wheel input stays passive and native inside the region and at both boundaries", () => {
  for (const top of [0, 20, 200, 480, 499.5, 500]) {
    const f = fixture({ top });
    expect(f.inner.wheelOptions).toEqual({ passive: true });
    for (const delta of [-60, -0.5, 0.5, 60]) {
      expect(f.wheel(delta).defaultPrevented).toBe(false);
      expect(f.inner.scrollTop).toBe(top);
    }
    expect(f.inner.calls).toHaveLength(0);
  }
  expect(frames.size).toBe(0);
});

test("short regions leave ancestor chaining to the browser without swallowing input", () => {
  const f = fixture({ top: 0 });
  f.inner.scrollHeight = 200;
  expect(f.wheel(60).defaultPrevented).toBe(false);
  expect(f.wheel(-60).defaultPrevented).toBe(false);
  expect(f.inner.calls).toHaveLength(0);
});

test("wheel bursts do not read layout, write positions or schedule animation", () => {
  const f = fixture();
  for (const property of ["scrollTop", "scrollHeight", "clientHeight"]) {
    Object.defineProperty(f.inner, property, {
      get() { throw new Error(`wheel must not measure ${property}`); },
    });
  }
  for (let i = 0; i < 100; i++) {
    expect(f.wheel(i % 2 ? -60 : 60).defaultPrevented).toBe(false);
  }
  expect(f.inner.calls).toHaveLength(0);
  expect(frames.size).toBe(0);
  expect(f.edges).toHaveLength(1);
});

test("line, page, zoom, horizontal and non-cancelable gestures are not rewritten", () => {
  const f = fixture({ top: 500 });
  for (const options of [{ deltaMode: 1 }, { deltaMode: 2 }, { ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 100 }]) {
    expect(f.wheel(60, options).defaultPrevented).toBe(false);
  }
  expect(f.wheel(60, {}, false).defaultPrevented).toBe(false);
  expect(f.inner.calls).toHaveLength(0);
});

test("scroll and resize notifications coalesce and publish only changed fade edges", () => {
  const f = fixture({ top: 0 });
  expect(f.edges).toEqual([{ top: false, bottom: true }]);
  f.inner.nativeScroll(100);
  f.inner.nativeScroll(200);
  f.observer.resize();
  expect(frames.size).toBe(1);
  expect(f.edges).toHaveLength(1);
  flushFrame();
  expect(f.edges.at(-1)).toEqual({ top: true, bottom: true });
  f.inner.nativeScroll(300);
  flushFrame();
  expect(f.edges).toHaveLength(2);
  f.inner.nativeScroll(500);
  flushFrame();
  expect(f.edges.at(-1)).toEqual({ top: true, bottom: false });
});

test("streamed growth follows internally and unchanged sizes do not rewrite scrollTop", () => {
  const f = fixture({ top: 500, follow: true });
  f.observer.resize();
  expect(f.inner.calls).toHaveLength(0);
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.scrollTop).toBe(600);
  f.observer.resize();
  expect(f.inner.calls).toEqual([{ top: 600, behavior: "instant" }]);
});

test("upward reading pauses following before native scroll or resize is delivered", () => {
  for (const cancelable of [true, false]) {
    const f = fixture({ top: 500, follow: true });
    f.wheel(-60, {}, cancelable);
    f.inner.scrollHeight = 900;
    f.observer.resize();
    expect(f.inner.calls).toHaveLength(0);
    expect(f.inner.scrollTop).toBe(500);
  }
});

test("upward scrolling over a short region pauses internal following", () => {
  const f = fixture({ top: 0, follow: true });
  f.inner.scrollHeight = 200;
  f.wheel(-60);
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.calls).toHaveLength(0);
});

test("unrelated or already-handled gestures do not pause stream following", () => {
  for (const options of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { deltaX: 100 }, { deltaY: 0 }]) {
    const f = fixture({ top: 500, follow: true });
    f.wheel(-60, options);
    f.inner.scrollHeight = 900;
    f.observer.resize();
    expect(f.inner.scrollTop).toBe(600);
  }
  const f = fixture({ top: 500, follow: true });
  const handled = new WheelStub(-60);
  handled.preventDefault();
  f.inner.dispatchEvent(handled);
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.scrollTop).toBe(600);
});

test("native scrolling away pauses following and returning to bottom resumes it", () => {
  const f = fixture({ top: 500, follow: true });
  f.inner.nativeScroll(440);
  f.inner.scrollHeight = 900;
  f.observer.resize();
  expect(f.inner.scrollTop).toBe(440);
  f.inner.nativeScroll(600);
  f.inner.scrollHeight = 1000;
  f.observer.resize();
  expect(f.inner.scrollTop).toBe(700);
});

test("keyboard and touch reading gestures pause following until a native return to bottom", () => {
  for (const gesture of ["key", "touch"] as const) {
    const f = fixture({ top: 500, follow: true });
    if (gesture === "key") {
      const event = new Event("keydown") as KeyboardEvent;
      Object.defineProperty(event, "key", { value: "PageUp" });
      f.inner.dispatchEvent(event);
    } else {
      const start = new Event("touchstart") as TouchEvent;
      Object.defineProperty(start, "touches", { value: [{ clientY: 100 }] });
      f.inner.dispatchEvent(start);
      const move = new Event("touchmove") as TouchEvent;
      Object.defineProperty(move, "touches", { value: [{ clientY: 140 }] });
      f.inner.dispatchEvent(move);
    }
    f.inner.scrollHeight = 900;
    f.observer.resize();
    expect(f.inner.calls).toHaveLength(0);
    f.inner.nativeScroll(600);
    f.inner.scrollHeight = 1000;
    f.observer.resize();
    expect(f.inner.scrollTop).toBe(700);
  }
});

test("downward keyboard and touch gestures retain following", () => {
  for (const gesture of ["key", "touch"] as const) {
    const f = fixture({ top: 500, follow: true });
    if (gesture === "key") {
      const event = new Event("keydown") as KeyboardEvent;
      Object.defineProperty(event, "key", { value: "PageDown" });
      f.inner.dispatchEvent(event);
    } else {
      const start = new Event("touchstart") as TouchEvent;
      Object.defineProperty(start, "touches", { value: [{ clientY: 140 }] });
      f.inner.dispatchEvent(start);
      const move = new Event("touchmove") as TouchEvent;
      Object.defineProperty(move, "touches", { value: [{ clientY: 100 }] });
      f.inner.dispatchEvent(move);
    }
    f.inner.scrollHeight = 900;
    f.observer.resize();
    expect(f.inner.scrollTop).toBe(600);
  }
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

test("disposing removes listeners, disconnects observation and cancels queued work", () => {
  const f = fixture({ top: 500 });
  f.inner.nativeScroll(100);
  expect(frames.size).toBe(1);
  expect(f.observer.observed.size).toBe(2);
  f.dispose();
  expect(f.observer.observed.size).toBe(0);
  expect(frames.size).toBe(0);
  f.inner.nativeScroll(0);
  expect(frames.size).toBe(0);
  flushFrame();
  expect(f.edges).toHaveLength(1);
  expect(f.wheel(60).defaultPrevented).toBe(false);
  expect(f.inner.calls).toHaveLength(0);
});
