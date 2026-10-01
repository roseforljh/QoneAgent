import { expect, test } from "bun:test";
import { bindSidebarDrag, type SidebarDrop } from "../src/lib/sidebar-drag";

// Exercise the actual delegated events, scheduling and cleanup without a browser.
class ViewStub extends EventTarget {
  timers = new Map<number, () => void>();
  frames = new Map<number, FrameRequestCallback>();
  nextId = 0;
  setTimeout(callback: () => void) { const id = ++this.nextId; this.timers.set(id, callback); return id; }
  clearTimeout(id: number) { this.timers.delete(id); }
  requestAnimationFrame(callback: FrameRequestCallback) { const id = ++this.nextId; this.frames.set(id, callback); return id; }
  cancelAnimationFrame(id: number) { this.frames.delete(id); }
  getComputedStyle(element: ElementStub) { return { overflowY: element.overflowY }; }
  hold() { for (const [id, callback] of [...this.timers]) { this.timers.delete(id); callback(); } }
  paint(time = 16) { for (const [id, callback] of [...this.frames]) { this.frames.delete(id); callback(time); } }
}

class DocumentStub extends EventTarget {
  defaultView = new ViewStub();
  body = new ElementStub(this);
  hit: ElementStub | null = null;
  hidden = false;
  createElement() { return new ElementStub(this); }
  elementFromPoint() { return this.hit; }
}

class ElementStub extends EventTarget {
  dataset: Record<string, string> = {};
  style: Record<string, string> = {};
  className = "";
  inert = false;
  isConnected = true;
  overflowY = "visible";
  scrollTop = 0;
  scrollHeight = 900;
  clientHeight = 300;
  parentElement: ElementStub | null = null;
  children: ElementStub[] = [];
  top = 0;
  height = 300;
  handle = false;
  constructor(public ownerDocument: DocumentStub) { super(); }
  contains(element: ElementStub) {
    for (let node: ElementStub | null = element; node; node = node.parentElement) if (node === this) return true;
    return false;
  }
  closest(selector: string): ElementStub | null {
    if (selector === "[data-sidebar-drag-handle]" && this.handle) return this;
    if (selector === "[data-sidebar-drag-id]" && this.dataset.sidebarDragId) return this;
    return this.parentElement?.closest(selector) ?? null;
  }
  getBoundingClientRect() { return { left: 0, right: 200, top: this.top, bottom: this.top + this.height, width: 200, height: this.height }; }
  setAttribute(key: string, value: string) { if (key.startsWith("data-")) this.dataset[this.dataKey(key)] = value; }
  removeAttribute(key: string) { delete this.dataset[this.dataKey(key)]; }
  private dataKey(key: string) { return key.replace(/^data-/, "").replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase()); }
  querySelectorAll() { return []; }
  cloneNode() { const clone = new ElementStub(this.ownerDocument); clone.dataset = { ...this.dataset }; return clone; }
  append(element: ElementStub) { element.parentElement = this; this.children.push(element); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((child) => child !== this); this.isConnected = false; }
  dom() { return this as unknown as HTMLElement; }
}

function pointer(type: string, target: ElementStub, x = 50, y = 90, overrides = {}) {
  const event = new Event(type, { cancelable: true });
  Object.defineProperty(event, "target", { value: target });
  Object.assign(event, { button: 0, isPrimary: true, pointerId: 1, clientX: x, clientY: y, ...overrides });
  return event;
}

function fixture(kind: SidebarDrop["kind"] = "session") {
  const doc = new DocumentStub();
  const root = new ElementStub(doc);
  const scroller = new ElementStub(doc);
  scroller.overflowY = "auto";
  root.append(scroller);
  const row = (id: string, top: number) => {
    const element = new ElementStub(doc);
    element.top = top;
    element.height = 30;
    element.dataset = { sidebarDragId: id, sidebarDragKind: kind, sidebarDragGroup: `${kind}:regular` };
    const handle = new ElementStub(doc);
    handle.handle = true;
    element.append(handle);
    scroller.append(element);
    return { element, handle };
  };
  const source = row("source", 80);
  const target = row("target", 140);
  const drops: SidebarDrop[] = [];
  const moves: SidebarDrop[] = [];
  const dispose = bindSidebarDrag(root.dom(), (drop) => drops.push(drop), (drop) => moves.push(drop));
  const down = (targetElement = source.handle, overrides = {}) => root.dispatchEvent(pointer("pointerdown", targetElement, 50, 90, overrides));
  const move = (x = 50, y = 145) => doc.dispatchEvent(pointer("pointermove", source.handle, x, y));
  const up = (x = 50, y = 145) => doc.dispatchEvent(pointer("pointerup", source.handle, x, y));
  const click = () => {
    const event = new Event("click", { cancelable: true });
    Object.assign(event, { detail: 1 });
    root.dispatchEvent(event);
    return event;
  };
  return { doc, root, scroller, source, target, drops, moves, dispose, down, move, up, click };
}

test("short clicks, early movement and action buttons do not reorder or suppress clicks", () => {
  const f = fixture();
  f.down(); f.up(); f.doc.defaultView.hold();
  expect(f.click().defaultPrevented).toBe(false);
  f.down(); f.move(); f.doc.defaultView.paint(); f.up();
  expect(f.doc.body.children).toHaveLength(0);
  expect(f.click().defaultPrevented).toBe(true);
  f.down(f.target.element); f.doc.defaultView.hold(); f.up();
  f.down(f.source.handle, { button: 2 }); f.doc.defaultView.hold();
  expect(f.drops).toHaveLength(0);
  expect(f.doc.defaultView.timers.size).toBe(0);
  f.dispose();
});

for (const kind of ["session", "workspace"] as const) {
  test(`${kind} drag reorders live above or below the target and suppresses the release click`, () => {
    const f = fixture(kind);
    f.down(); f.move(); f.doc.defaultView.paint();
    expect(f.root.dataset.sidebarDragging).toBe("true");
    expect(f.doc.body.children).toHaveLength(1);
    f.doc.hit = f.target.handle;
    f.move(); f.doc.defaultView.paint();
    expect(f.target.element.dataset.dropEdge).toBe("before");
    expect(f.moves).toEqual([{ kind, source: "source", target: "target", after: false }]);
    f.up();
    expect(f.drops).toEqual([{ kind, source: "source", target: "target", after: false }]);
    expect(f.click().defaultPrevented).toBe(true);
    expect(f.doc.body.children).toHaveLength(0);
    expect(f.target.element.dataset.dropEdge).toBeUndefined();
    expect(f.root.dataset.sidebarDragging).toBeUndefined();
    f.down(); f.move(50, 165); f.doc.defaultView.paint(); f.up(50, 165);
    expect(f.drops.at(-1)?.after).toBe(true); // release uses its coordinates even before the next paint
    f.down(); f.up();
    expect(f.click().defaultPrevented).toBe(false);
    f.dispose();
  });
}

test("cross-project, cross-pin, outside-sidebar and self drops are rejected", () => {
  const f = fixture();
  for (const group of ["session:workspace:other", "session:pinned"]) {
    f.target.element.dataset.sidebarDragGroup = group;
    f.doc.hit = f.target.handle;
    f.down(); f.doc.defaultView.hold(); f.move(); f.doc.defaultView.paint(); f.up();
    expect(f.target.element.dataset.dropEdge).toBeUndefined();
  }
  f.target.element.dataset.sidebarDragGroup = "session:regular";
  f.down(); f.doc.defaultView.hold(); f.up(250, 145);
  f.doc.hit = f.source.handle;
  f.down(); f.doc.defaultView.hold(); f.up();
  expect(f.drops).toHaveLength(0);
  f.dispose();
});

test("Escape, pointer cancellation, window blur, hidden document and disposal clean up without saving", () => {
  const f = fixture();
  const cancellations = [
    () => { const event = new Event("keydown", { cancelable: true }); Object.assign(event, { key: "Escape" }); f.doc.dispatchEvent(event); },
    () => f.doc.dispatchEvent(pointer("pointercancel", f.source.handle)),
    () => f.doc.defaultView.dispatchEvent(new Event("blur")),
    () => { f.doc.hidden = true; f.doc.dispatchEvent(new Event("visibilitychange")); },
    f.dispose,
  ];
  for (const cancel of cancellations) {
    f.down(); f.doc.defaultView.hold(); f.doc.hit = f.target.handle; f.move(); f.doc.defaultView.paint();
    cancel(); f.up();
    expect(f.doc.body.children).toHaveLength(0);
    expect(f.doc.defaultView.frames.size).toBe(0);
    expect(f.doc.defaultView.timers.size).toBe(0);
    expect(f.drops).toHaveLength(0);
  }
});

test("edge scrolling continues while held, stops outside, and cancels when the source disappears", () => {
  const f = fixture();
  f.down(); f.doc.defaultView.hold(); f.move(50, 295); f.doc.defaultView.paint();
  expect(f.scroller.scrollTop).toBeGreaterThan(0);
  expect(f.doc.defaultView.frames.size).toBe(1);
  const top = f.scroller.scrollTop;
  f.move(250, 295); f.doc.defaultView.paint(32);
  expect(f.scroller.scrollTop).toBe(top);
  expect(f.doc.defaultView.frames.size).toBe(0);
  f.source.element.isConnected = false;
  f.move(); f.doc.defaultView.paint(48);
  expect(f.doc.body.children).toHaveLength(0);
  expect(f.drops).toHaveLength(0);
  f.dispose();
});
