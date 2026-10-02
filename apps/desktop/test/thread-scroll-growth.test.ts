import { afterEach, beforeEach, expect, test } from "bun:test";
import { mountThreadScrollController } from "../src/lib/thread-scroll-controller";
import { bindScrollRegion } from "../src/lib/scroll-region";

class ElementStub extends EventTarget {
  scrollTop = 0;
  scrollHeight = 1600;
  clientHeight = 600;
  top = 0;
  height = 0;
  scrollPaddingTop = "auto";
  ownerDocument = { defaultView: { getComputedStyle: (element: ElementStub) => ({ scrollPaddingTop: element.scrollPaddingTop }) } };
  parentElement: ElementStub | null = null;
  reserve: ElementStub | null = null;
  viewport: ElementStub | null = null;
  calls: number[] = [];
  getBoundingClientRect() {
    const top = this.top - (this.viewport?.scrollTop ?? 0);
    return { top, bottom: top + this.height, height: this.height } as DOMRect;
  }
  querySelector() { return this.reserve; }
  closest() { return null; }
  scrollTo({ top }: ScrollToOptions) {
    this.scrollTop = Math.max(0, Math.min(top ?? 0, this.scrollHeight - this.clientHeight));
    this.calls.push(this.scrollTop);
    this.dispatchEvent(new Event("scroll"));
  }
  dom() { return this as unknown as HTMLElement; }
}

class ResizeStub {
  static instances: ResizeStub[] = [];
  observed = new Set<HTMLElement>();
  constructor(private callback: ResizeObserverCallback) { ResizeStub.instances.push(this); }
  observe(element: HTMLElement) { this.observed.add(element); }
  unobserve(element: HTMLElement) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); }
  static change(element: ElementStub) {
    for (const observer of this.instances) {
      if (observer.observed.has(element.dom())) observer.callback([], observer as unknown as ResizeObserver);
    }
  }
}
class MutationStub {
  static instances: MutationStub[] = [];
  constructor(private callback: MutationCallback) { MutationStub.instances.push(this); }
  observe() {}
  disconnect() {}
  notify() { this.callback([], this as unknown as MutationObserver); }
}
const globals = ["Element", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame", "window"] as const;
let originals: Array<PropertyDescriptor | undefined>;
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let disposers: Array<() => void> = [];
beforeEach(() => {
  originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key));
  const values = [ElementStub, ResizeStub, MutationStub,
    (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; },
    (id: number) => frames.delete(id), { matchMedia: () => ({ matches: true }) }];
  globals.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[i] }));
  ResizeStub.instances = [];
  MutationStub.instances = [];
});
afterEach(() => {
  disposers.splice(0).forEach((dispose) => dispose());
  frames.clear();
  globals.forEach((key, i) => {
    if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!);
    else Reflect.deleteProperty(globalThis, key);
  });
});
function flush() {
  const pending = [...frames.values()]; frames.clear();
  pending.forEach((fn) => fn(performance.now()));
}
function fixture() {
  const viewport = new ElementStub(); viewport.scrollTop = 600;
  const content = new ElementStub(); content.height = 1600; content.viewport = viewport;
  const footer = new ElementStub(); footer.top = 500;
  const reserve = new ElementStub(); reserve.height = 500; content.reserve = reserve;
  let visible = false;
  const controller = mountThreadScrollController({
    viewport: viewport.dom(), content: content.dom(), footer: footer.dom(), endContent: null,
    turn: { turnId: "u", running: true, phase: "prework" },
    restored: { turnId: "u", mode: "prework_follow" }, hasRestoration: true,
    onVisibility: (value) => { visible = value; }, onSave: () => {},
  });
  disposers.push(controller.dispose);
  return { viewport, content, footer, reserve, controller, visible: () => visible };
}

test("reserve shrinkage wakes follow even when the message list and scroll height stay constant", () => {
  const f = fixture();
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(800);
  expect(f.visible()).toBe(false);
});

test("reserve replacement reconnects observation and detached reserve no longer schedules work", () => {
  const f = fixture();
  const replacement = new ElementStub(); replacement.height = 300;
  f.content.reserve = replacement;
  MutationStub.instances[0]!.notify(); flush();
  expect(f.viewport.scrollTop).toBe(800);
  ResizeStub.change(f.reserve);
  expect(frames.size).toBe(0);
  replacement.height = 200;
  ResizeStub.change(replacement); flush();
  expect(f.viewport.scrollTop).toBe(900);
});

test("reading upward pauses reserve and disclosure growth until explicit bottom navigation", () => {
  const f = fixture();
  f.viewport.scrollTo({ top: 500 });
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(500);
  expect(f.visible()).toBe(true);
  f.controller.scrollToBottom();
  expect(f.viewport.scrollTop).toBe(800);
  f.reserve.height = 200;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(900);
});

test("scrollbar dragging pauses even when content height changes with the gesture", () => {
  const f = fixture();
  f.viewport.dispatchEvent(new Event("pointerdown"));
  f.viewport.scrollTop = 500;
  f.viewport.scrollHeight += 100;
  f.viewport.dispatchEvent(new Event("scroll"));
  f.reserve.height = 200;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(500);
  f.viewport.dispatchEvent(new Event("pointerup"));
});

test("tool-only completion still follows final expansion and viewport/footer resizing", () => {
  const f = fixture();
  f.controller.sync({ turnId: "u", running: false, phase: "idle" }); flush();
  f.content.height += 100; f.viewport.scrollHeight += 100;
  ResizeStub.change(f.content); flush();
  expect(f.viewport.scrollTop).toBe(700);
  f.footer.top -= 100;
  ResizeStub.change(f.footer); flush();
  expect(f.viewport.scrollTop).toBe(800);
});

test("an already overflowing streaming panel follows on its first measured frame", () => {
  const region = new ElementStub(); region.clientHeight = 300; region.scrollHeight = 900;
  const content = new ElementStub();
  disposers.push(bindScrollRegion(region.dom(), content.dom(), { autoFollow: () => true, onEdgesChange: () => {} }));
  ResizeStub.change(content); flush();
  expect(region.scrollTop).toBe(600);
  region.scrollTo({ top: 400 });
  region.scrollHeight += 100;
  ResizeStub.change(content); flush();
  expect(region.scrollTop).toBe(400);
});

test("opening a completed overflowing panel preserves its beginning", () => {
  const region = new ElementStub(); region.clientHeight = 300; region.scrollHeight = 900;
  const content = new ElementStub();
  disposers.push(bindScrollRegion(region.dom(), content.dom(), { autoFollow: () => false, onEdgesChange: () => {} }));
  ResizeStub.change(content); flush();
  expect(region.scrollTop).toBe(0);
});

test("pending-message reveal uses the same safe top edge as the primitive placement", () => {
  const f = fixture();
  f.viewport.scrollPaddingTop = "32px";
  const message = new ElementStub(); message.viewport = f.viewport; message.top = 610; message.height = 60;
  f.controller.reveal(message.dom());
  expect(message.getBoundingClientRect().top).toBe(32);
  message.top = 800;
  f.viewport.calls = [];
  f.controller.reveal(message.dom());
  expect(f.viewport.calls).toEqual([768]);
});
