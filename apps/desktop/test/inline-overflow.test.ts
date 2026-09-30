import { afterEach, beforeEach, expect, test } from "bun:test";
import { observeInlineOverflow } from "../src/lib/inline-overflow";

class ElementStub {
  measurements = 0;
  constructor(public width: number) {}
  getBoundingClientRect() { this.measurements++; return { width: this.width }; }
  dom() { return this as unknown as HTMLElement; }
}
class ObserverStub {
  static instances: ObserverStub[] = [];
  observed = new Set<HTMLElement>();
  constructor(private callback: ResizeObserverCallback) { ObserverStub.instances.push(this); }
  observe(element: HTMLElement) { this.observed.add(element); }
  disconnect() { this.observed.clear(); }
  resize() {
    const entries = [...this.observed].map((target) => ({ target, contentRect: { width: (target as unknown as ElementStub).width } } as ResizeObserverEntry));
    this.callback(entries, this as unknown as ResizeObserver);
  }
}
const originalObserver = globalThis.ResizeObserver;
let dispose: (() => void) | undefined;
beforeEach(() => {
  ObserverStub.instances = [];
  globalThis.ResizeObserver = ObserverStub as unknown as typeof ResizeObserver;
});
afterEach(() => {
  dispose?.();
  dispose = undefined;
  globalThis.ResizeObserver = originalObserver;
});
function fixture(available: number, natural: number) {
  const viewport = new ElementStub(available);
  const content = new ElementStub(natural);
  const changes: boolean[] = [];
  dispose = observeInlineOverflow(viewport.dom(), content.dom(), (overflow) => changes.push(overflow));
  return { viewport, content, changes, observer: ObserverStub.instances[0]! };
}

test("short, exactly fitting and subpixel-rounded labels never fade", () => {
  const f = fixture(300, 100);
  f.content.width = 300;
  f.observer.resize();
  f.content.width = 300.5;
  f.observer.resize();
  expect(f.changes).toEqual([false]);
});
test("streamed content growth and active/resting label switches update overflow", () => {
  const f = fixture(300, 200);
  expect(f.observer.observed).toEqual(new Set([f.viewport.dom(), f.content.dom()]));
  f.content.width = 1200;
  f.observer.resize();
  f.observer.resize();
  f.content.width = 100;
  f.observer.resize();
  expect(f.changes).toEqual([false, true, false]);
});
test("window/sidebar resize clears the fade when the entire label fits again", () => {
  const f = fixture(300, 600);
  f.viewport.width = 800;
  f.observer.resize();
  f.viewport.width = 200;
  f.observer.resize();
  expect(f.changes).toEqual([true, false, true]);
});
test("animation/resize callbacks reuse RO measurements without synchronous layout reads", () => {
  const f = fixture(300, 200);
  for (let frame = 0; frame < 20; frame++) {
    f.content.width += 20;
    f.observer.resize();
  }
  expect(f.viewport.measurements).toBe(1);
  expect(f.content.measurements).toBe(1);
  expect(f.changes).toEqual([false, true]);
});

test("hidden execution regions remeasure when expanded and release both observations", () => {
  const f = fixture(0, 0);
  f.content.width = 500;
  f.observer.resize();
  f.viewport.width = 200;
  f.observer.resize();
  expect(f.changes).toEqual([false, true]);
  dispose?.();
  expect(f.observer.observed.size).toBe(0);
});
