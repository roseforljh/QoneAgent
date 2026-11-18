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
  expect(f.viewport.scrollTop).toBe(1000);
  expect(f.visible()).toBe(false);
});

test("reserve replacement reconnects observation and detached reserve no longer schedules work", () => {
  const f = fixture();
  const replacement = new ElementStub(); replacement.height = 300;
  f.content.reserve = replacement;
  MutationStub.instances[0]!.notify(); flush();
  expect(f.viewport.scrollTop).toBe(1000);
  ResizeStub.change(f.reserve);
  expect(frames.size).toBe(0);
  replacement.height = 200;
  ResizeStub.change(replacement); flush();
  expect(f.viewport.scrollTop).toBe(1000);
});

test("reading upward pauses reserve and disclosure growth until explicit bottom navigation", () => {
  const f = fixture();
  f.viewport.scrollTo({ top: 500 });
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(500);
  expect(f.visible()).toBe(true);
  f.controller.scrollToBottom();
  expect(f.viewport.scrollTop).toBe(1000);
  f.reserve.height = 200;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(1000);
});

test("bottom navigation includes the top-anchor reserve in the native tail", () => {
  const f = fixture();
  f.viewport.scrollTo({ top: 500 });
  f.controller.scrollToBottom();
  expect(f.viewport.scrollTop).toBe(f.viewport.scrollHeight - f.viewport.clientHeight);
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
  expect(f.viewport.scrollTop).toBe(1100);
  f.footer.top -= 100;
  ResizeStub.change(f.footer); flush();
  expect(f.viewport.scrollTop).toBe(1100);
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

test.each([false, true])("new turn watches its reserve then follows overflow (prework batched: %s)", (batched) => {
  const f = fixture();
  f.reserve.height = 800;
  f.controller.sync({ turnId: "next", running: true, phase: batched ? "prework" : "idle" });
  if (!batched) {
    const message = new ElementStub(); message.viewport = f.viewport; message.top = 600;
    f.controller.reveal(message.dom());
    f.controller.sync({ turnId: "next", running: true, phase: "prework" });
  }
  flush();
  expect(f.viewport.scrollTop).toBe(600);
  f.reserve.height = 600;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(600);
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(1000);
  f.controller.sync({ turnId: "next", running: true, phase: "final_answer" }); flush();
  f.reserve.height = 200;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(1000);
});

test("a direct final answer still follows after skipping prework", () => {
  const f = fixture();
  f.reserve.height = 800;
  f.controller.sync({ turnId: "next", running: true, phase: "idle" });
  f.controller.sync({ turnId: "next", running: true, phase: "final_answer" });
  flush();
  expect(f.viewport.scrollTop).toBe(600);
  f.reserve.height = 600;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(600);
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(1000);
});

test("final answer overflow follows even when prework fit inside the reserve", () => {
  const f = fixture();
  f.reserve.height = 800;
  f.controller.sync({ turnId: "next", running: true, phase: "prework" }); flush();
  f.controller.sync({ turnId: "next", running: true, phase: "final_answer" }); flush();
  expect(f.viewport.scrollTop).toBe(600);
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(1000);
});

test("reading pauses a direct final answer before its first overflow", () => {
  const f = fixture();
  f.reserve.height = 800;
  f.controller.sync({ turnId: "next", running: true, phase: "idle" }); flush();
  f.viewport.scrollTo({ top: 550 });
  f.controller.sync({ turnId: "next", running: true, phase: "final_answer" });
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(550);
});

test("reading after placement stays paused through the first work and final answer", () => {
  const f = fixture();
  f.reserve.height = 800;
  f.controller.sync({ turnId: "next", running: true, phase: "idle" }); flush();
  f.viewport.scrollTo({ top: 550 });
  f.controller.sync({ turnId: "next", running: true, phase: "prework" });
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(550);
  f.controller.sync({ turnId: "next", running: true, phase: "final_answer" }); flush();
  expect(f.viewport.scrollTop).toBe(550);
  f.controller.scrollToBottom();
  expect(f.viewport.scrollTop).toBe(1000);
});

test.each([0, 180])("completed tail including its spacing agrees with the native scroll limit (end content %ipx)", (endHeight) => {
  const f = fixture();
  f.controller.dispose(); disposers.pop();
  // The existing 28px separation is now inside each measured content box.
  f.reserve.height = 0;
  f.content.height = 1200 + 28;
  const end = new ElementStub(); end.viewport = f.viewport;
  end.top = f.content.height; end.height = endHeight ? endHeight + 28 : 0;
  f.viewport.scrollHeight = f.content.height + end.height + 100;
  const controller = mountThreadScrollController({
    viewport: f.viewport.dom(), content: f.content.dom(), footer: f.footer.dom(), endContent: end.dom(),
    turn: { turnId: "u", running: false, phase: "idle" }, hasRestoration: false,
    onVisibility: () => {}, onSave: () => {},
  });
  disposers.push(controller.dispose);
  expect(f.viewport.scrollTop).toBe(f.viewport.scrollHeight - f.viewport.clientHeight);
  f.viewport.scrollTo({ top: f.viewport.scrollHeight });
  const nativeBottom = f.viewport.scrollTop;
  ResizeStub.change(f.content); flush();
  expect(f.viewport.scrollTop).toBe(nativeBottom);
  // Expanding final file changes still uses that same bottom.
  f.content.height += 120; end.top += 120; f.viewport.scrollHeight += 120;
  ResizeStub.change(f.content); flush();
  expect(f.viewport.scrollTop).toBe(f.viewport.scrollHeight - f.viewport.clientHeight);
});

test.each(["wheel", "touch", "pointer"])("scrolling down into the top-anchor reserve does not snap back (%s)", (input) => {
  const f = fixture();
  f.controller.sync({ turnId: "next", running: true, phase: "prework" });
  flush();
  if (input === "wheel") {
    const wheel = new Event("wheel");
    Object.defineProperties(wheel, { deltaY: { value: 80 }, deltaX: { value: 0 } });
    f.viewport.dispatchEvent(wheel);
  } else if (input === "touch") {
    const start = new Event("touchstart");
    Object.defineProperty(start, "touches", { value: [{ clientY: 300 }] });
    f.viewport.dispatchEvent(start);
    const move = new Event("touchmove");
    Object.defineProperty(move, "touches", { value: [{ clientY: 220 }] });
    f.viewport.dispatchEvent(move);
  } else f.viewport.dispatchEvent(new Event("pointerdown"));
  f.viewport.scrollTop = 780;
  f.viewport.dispatchEvent(new Event("scroll"));
  f.reserve.height = 300;
  ResizeStub.change(f.reserve); flush();
  expect(f.viewport.scrollTop).toBe(780);
});

test("reserve release on completion animates the bottom space drop smoothly instead of teleporting", () => {
  (globalThis as { window: { matchMedia: () => { matches: boolean } } }).window.matchMedia = () => ({ matches: false });
  class SpacerElement extends EventTarget {
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    removed = false;
    setAttribute() {}
    remove() { this.removed = true; onRemove(); }
  }
  let activeSpacer: SpacerElement | null = null;
  let naturalScrollHeight = 1100;
  const viewport = new ElementStub();
  viewport.clientHeight = 600;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => naturalScrollHeight + (content.reserve ? content.reserve.height : 0) + (activeSpacer && !activeSpacer.removed ? Number.parseFloat(activeSpacer.style.height || "0") : 0),
  });
  const onRemove = () => { activeSpacer = null; };
  const content = new ElementStub();
  content.height = 1100;
  content.viewport = viewport;
  content.parentElement = viewport;
  (content as unknown as { after: (el: SpacerElement) => void }).after = (el) => { activeSpacer = el; };
  content.ownerDocument = {
    defaultView: { getComputedStyle: (element: ElementStub) => ({ scrollPaddingTop: element.scrollPaddingTop }) },
    createElement: () => new SpacerElement(),
  } as unknown as ElementStub["ownerDocument"];
  const footer = new ElementStub(); footer.top = 500;
  const reserve = new ElementStub(); reserve.height = 400; reserve.viewport = viewport;
  content.reserve = reserve;
  Object.defineProperty(reserve, "isConnected", { configurable: true, get: () => content.reserve === reserve });
  viewport.scrollTop = 900; // 1100 + 400 - 600

  let visible = false;
  const controller = mountThreadScrollController({
    viewport: viewport.dom(), content: content.dom(), footer: footer.dom(), endContent: null,
    turn: { turnId: "u", running: true, phase: "final_answer" },
    restored: { turnId: "u", mode: "user_follow" }, hasRestoration: true,
    onVisibility: (value) => { visible = value; }, onSave: () => {},
  });
  disposers.push(controller.dispose);
  viewport.dispatchEvent(new Event("scroll"));

  // 运行结束且 "streaming" 卸载导致 reserve 消失，sync 应在首帧前无缝保住 scrollTop 并插入过渡占位。
  content.reserve = null;
  controller.sync({ turnId: "u", running: false, phase: "idle" });
  expect(activeSpacer).not.toBeNull();
  expect(Number.parseFloat(activeSpacer!.style.height!)).toBe(400);
  expect(viewport.scrollTop).toBe(900);
  expect(visible).toBe(false);

  // 逐帧推进动画，验证高度与 scrollTop 平滑缓动下落而非一步跳变。
  const baseNow = performance.now();
  const originalNow = performance.now;
  try {
    performance.now = () => baseNow + 140;
    flush();
    expect(viewport.scrollTop).toBeLessThan(900);
    expect(viewport.scrollTop).toBeGreaterThan(500);
    expect(activeSpacer).not.toBeNull();

    performance.now = () => baseNow + 320;
    flush();
    expect(viewport.scrollTop).toBe(500);
    expect(activeSpacer).toBeNull();
  } finally {
    performance.now = originalNow;
  }
});

test("upward wheel during reserve release keeps user scroll position while spacer finishes cleaning up", () => {
  (globalThis as { window: { matchMedia: () => { matches: boolean } } }).window.matchMedia = () => ({ matches: false });
  class SpacerElement extends EventTarget {
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    removed = false;
    setAttribute() {}
    remove() { this.removed = true; activeSpacer = null; }
  }
  let activeSpacer: SpacerElement | null = null;
  const viewport = new ElementStub();
  viewport.clientHeight = 600;
  Object.defineProperty(viewport, "scrollHeight", {
    configurable: true,
    get: () => 1100 + (content.reserve ? content.reserve.height : 0) + (activeSpacer && !activeSpacer.removed ? Number.parseFloat(activeSpacer.style.height || "0") : 0),
  });
  const content = new ElementStub();
  content.height = 1100;
  content.viewport = viewport;
  content.parentElement = viewport;
  (content as unknown as { after: (el: SpacerElement) => void }).after = (el) => { activeSpacer = el; };
  content.ownerDocument = {
    defaultView: { getComputedStyle: (element: ElementStub) => ({ scrollPaddingTop: element.scrollPaddingTop }) },
    createElement: () => new SpacerElement(),
  } as unknown as ElementStub["ownerDocument"];
  const footer = new ElementStub(); footer.top = 500;
  const reserve = new ElementStub(); reserve.height = 400;
  content.reserve = reserve;
  viewport.scrollTop = 900;

  const controller = mountThreadScrollController({
    viewport: viewport.dom(), content: content.dom(), footer: footer.dom(), endContent: null,
    turn: { turnId: "u", running: true, phase: "final_answer" },
    restored: { turnId: "u", mode: "user_follow" }, hasRestoration: true,
    onVisibility: () => {}, onSave: () => {},
  });
  disposers.push(controller.dispose);
  viewport.dispatchEvent(new Event("scroll"));

  content.reserve = null;
  controller.sync({ turnId: "u", running: false, phase: "idle" });
  expect(activeSpacer).not.toBeNull();

  // 用户在释放动画期间向上滚到自然底部之上（300 < 500）。
  const wheel = new Event("wheel");
  Object.defineProperties(wheel, { deltaY: { value: -120 }, deltaX: { value: 0 } });
  viewport.dispatchEvent(wheel);
  viewport.scrollTo({ top: 300 });

  const baseNow = performance.now();
  const originalNow = performance.now;
  try {
    performance.now = () => baseNow + 320;
    flush();
    expect(viewport.scrollTop).toBe(300);
    expect(activeSpacer).toBeNull();
  } finally {
    performance.now = originalNow;
  }
});

test("collapse-induced bottom clamp does not pause follow mode", () => {
  const f = fixture();
  f.reserve.height = 0;
  f.content.height = 1500;
  f.viewport.scrollHeight = 1600; // 1500 内容 + 100 页脚
  f.viewport.scrollTop = 1000;
  f.viewport.dispatchEvent(new Event("scroll"));

  // 收起动画让内容从 1500 缩到 1300，浏览器将 scrollTop 夹到 800（底部极限）。
  f.content.height = 1300;
  f.viewport.scrollHeight = 1400;
  f.viewport.scrollTop = 800;
  f.viewport.dispatchEvent(new Event("scroll"));

  // 随后结论输出使内容增长到 1400，控制器仍保持跟随到底部 900。
  f.content.height = 1400;
  f.viewport.scrollHeight = 1500;
  ResizeStub.change(f.content);
  flush();
  expect(f.viewport.scrollTop).toBe(900);
});
