import { afterEach, beforeEach, expect, test } from "bun:test";
import { bindTopPopupHeight } from "../src/lib/popup-height";

class ViewStub extends EventTarget {
  innerHeight = 800;
  visualViewport = Object.assign(new EventTarget(), { offsetTop: 0, height: 800 });
  frames = new Map<number, FrameRequestCallback>();
  private frameId = 0;
  getComputedStyle(element: ElementStub) { return element.overflow; }
  requestAnimationFrame(callback: FrameRequestCallback) { const id = ++this.frameId; this.frames.set(id, callback); return id; }
  cancelAnimationFrame(id: number) { this.frames.delete(id); }
  flush() { const frames = [...this.frames.values()]; this.frames.clear(); frames.forEach((callback) => callback(0)); }
}

class ElementStub extends EventTarget {
  tagName = "DIV";
  role = "";
  overflow = { overflowX: "visible", overflowY: "visible" };
  measurements = 0;
  properties = new Map<string, string>();
  style = {
    setProperty: (name: string, value: string) => this.properties.set(name, value),
    removeProperty: (name: string) => this.properties.delete(name),
  };
  constructor(
    public ownerDocument: { defaultView: ViewStub; body: ElementStub | null },
    public parentElement: ElementStub | null,
    public top: number,
    public bottom: number,
  ) { super(); }
  getAttribute(attribute: string) { return attribute === "role" ? this.role : null; }
  getBoundingClientRect() { this.measurements++; return { top: this.top, bottom: this.bottom }; }
  dom() { return this as unknown as HTMLDivElement; }
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
  disposers.forEach((dispose) => dispose());
  disposers = [];
  globalThis.ResizeObserver = originalObserver;
});

function fixture() {
  const view = new ViewStub();
  const ownerDocument = { defaultView: view, body: null as ElementStub | null };
  const body = new ElementStub(ownerDocument, null, 0, 800);
  ownerDocument.body = body;
  const pane = new ElementStub(ownerDocument, body, 100, 800);
  pane.overflow.overflowY = "hidden";
  const composer = new ElementStub(ownerDocument, pane, 500, 700);
  const popup = new ElementStub(ownerDocument, composer, 200, 492);
  const dispose = bindTopPopupHeight(popup.dom())!;
  disposers.push(dispose);
  return {
    view, pane, composer, popup, dispose, observer: ObserverStub.instances[0]!,
    height: () => popup.properties.get("--q-popup-available-height"),
  };
}

test("composer suggestions use the space above the composer within its pane", () => {
  const f = fixture();
  expect(f.height()).toBe("392px");
  expect(f.observer.observed).toEqual(new Set([f.popup.dom(), f.composer.dom(), f.pane.dom()]));
});

test("small windows and growing composer contents reduce the internal scroll height", () => {
  const f = fixture();
  f.popup.bottom = 180;
  f.observer.resize();
  f.view.flush();
  expect(f.height()).toBe("80px");
  f.popup.bottom = 80;
  f.observer.resize();
  f.view.flush();
  expect(f.height()).toBe("0px");
});

test("resizing only a parent pane updates the available height", () => {
  const f = fixture();
  f.pane.top = 300;
  f.observer.resize();
  f.view.flush();
  expect(f.height()).toBe("192px");
  f.pane.top = 0;
  f.view.dispatchEvent(new Event("resize"));
  f.view.flush();
  expect(f.height()).toBe("492px");
});

test("zoomed visual viewports constrain suggestions and update on viewport events", () => {
  const f = fixture();
  f.view.visualViewport.offsetTop = 250;
  f.view.visualViewport.dispatchEvent(new Event("resize"));
  f.view.flush();
  expect(f.height()).toBe("242px");
});

test("scroll and resize bursts share one layout read per frame", () => {
  const f = fixture();
  for (let event = 0; event < 20; event++) {
    f.view.dispatchEvent(new Event("scroll"));
    f.observer.resize();
  }
  expect(f.view.frames.size).toBe(1);
  expect(f.popup.measurements).toBe(1);
  f.popup.bottom = 400;
  f.view.flush();
  expect(f.popup.measurements).toBe(2);
  expect(f.height()).toBe("300px");
});

test("closing a popup releases observations, listeners, pending work and inline sizing", () => {
  const f = fixture();
  f.observer.resize();
  f.dispose();
  disposers = [];
  expect(f.observer.observed.size).toBe(0);
  expect(f.view.frames.size).toBe(0);
  expect(f.height()).toBeUndefined();
  f.view.dispatchEvent(new Event("resize"));
  f.view.visualViewport.dispatchEvent(new Event("scroll"));
  expect(f.view.frames.size).toBe(0);
});
