import { afterEach, beforeEach, expect, test } from "bun:test";
import { dirname, join } from "node:path";
import { getThreadScrollState, pruneThreadScrollStates } from "../src/lib/thread-scroll-state";

// Exercise the installed, patched implementation, not a copy of its logic.
const { mountTopAnchorReserve } = await import(join(
  dirname(Bun.resolveSync("@assistant-ui/react", import.meta.dir)),
  "primitives/thread/topAnchor/mountTopAnchorReserve.js",
));

class ElementStub {
  style: Record<string, string> = {};
  dataset: Record<string, string> = {};
  parentElement: ElementStub | null = null;
  children: ElementStub[] = [];
  offsetTop = 0;
  offsetParent: ElementStub | null = null;
  clientHeight = 400;
  contentHeight = 1600;
  scrollTop = 0;
  scrollPaddingTop = "auto";
  ownerDocument = { defaultView: { getComputedStyle: (element: ElementStub) => ({ scrollPaddingTop: element.scrollPaddingTop }) } };
  calls: { top: number; behavior: string }[] = [];
  get offsetHeight() { return Number.parseFloat(this.style.height ?? "64"); }
  get scrollHeight(): number { return this.contentHeight + this.children.reduce((sum, child) => sum + (child.dataset.auiTopAnchorReserve !== undefined ? child.offsetHeight : 0), 0); }
  get previousElementSibling() { return this.parentElement?.children[this.parentElement.children.indexOf(this) - 1] ?? null; }
  get lastElementChild() { return this.children.at(-1) ?? null; }
  setAttribute() {}
  append(child: ElementStub) { child.remove(); child.parentElement = this; this.children.push(child); }
  after(child: ElementStub) {
    child.remove();
    child.parentElement = this.parentElement;
    this.parentElement!.children.splice(this.parentElement!.children.indexOf(this) + 1, 0, child);
  }
  remove() {
    if (this.parentElement) this.parentElement.children.splice(this.parentElement.children.indexOf(this), 1);
    this.parentElement = null;
  }
  scrollTo(options: { top: number; behavior: string }) {
    this.calls.push(options);
    this.scrollTop = Math.max(0, Math.min(options.top, this.scrollHeight - this.clientHeight));
  }
}

const globals = ["document", "window", "ResizeObserver", "MutationObserver", "requestAnimationFrame", "cancelAnimationFrame"] as const;
let originals: PropertyDescriptor[];
const frames = new Map<number, () => void>();
let nextFrame = 0;
class ObserverStub { observe() {} disconnect() {} }
beforeEach(() => {
  originals = globals.map((key) => Object.getOwnPropertyDescriptor(globalThis, key)!);
  const values = [
    { createElement: () => new ElementStub() }, { devicePixelRatio: 1 }, ObserverStub, ObserverStub,
    (fn: () => void) => { frames.set(++nextFrame, fn); return nextFrame; },
    (id: number) => frames.delete(id),
  ];
  globals.forEach((key, i) => Object.defineProperty(globalThis, key, { configurable: true, writable: true, value: values[i] }));
});
afterEach(() => {
  frames.clear();
  globals.forEach((key, i) => {
    if (originals[i]) Object.defineProperty(globalThis, key, originals[i]!);
    else Reflect.deleteProperty(globalThis, key);
  });
  pruneThreadScrollStates([]);
});
function flushFrames() {
  for (let count = 0; frames.size && count < 10; count++) {
    const pending = [...frames.values()]; frames.clear(); pending.forEach((fn) => fn());
  }
  expect(frames.size).toBe(0);
}
function fixture() {
  const viewport = new ElementStub();
  const anchor = new ElementStub(); anchor.dataset.messageId = "user-a"; anchor.offsetTop = 1400;
  const target = new ElementStub(); viewport.append(target);
  const state = {
    turnAnchor: "top", element: { viewport, anchor, target },
    targetConfig: { tallerThan: 160, visibleHeight: 96 },
    topAnchorTurn: { anchorId: "user-a", targetId: "streaming" },
  };
  const listeners = new Set<() => void>();
  const store = { getState: () => state, subscribe: (fn: () => void) => { listeners.add(fn); return () => listeners.delete(fn); } };
  return { viewport, anchor, target, state, store, notify: () => listeners.forEach((fn) => fn()) };
}

test("returning to a running turn restores before frames and never replays smooth placement", () => {
  const f = fixture();
  const snapshot = { current: { scrollTop: 760, topAnchorTurn: f.state.topAnchorTurn } };
  const dispose = mountTopAnchorReserve(f.store, snapshot);
  expect(f.viewport.scrollTop).toBe(760);
  flushFrames();
  f.viewport.contentHeight += 200; f.notify(); flushFrames();
  expect(f.viewport.scrollTop).toBe(760);
  expect(f.viewport.calls.every((call) => call.behavior === "instant")).toBe(true);
  f.viewport.scrollTop = 420;
  dispose();
  expect(snapshot.current.scrollTop).toBe(420);
});

test("restoration leaves the next new user turn's official smooth placement intact", () => {
  const f = fixture();
  const dispose = mountTopAnchorReserve(f.store, { current: { scrollTop: 400, topAnchorTurn: f.state.topAnchorTurn } });
  flushFrames();
  f.anchor.dataset.messageId = "user-b";
  f.state.topAnchorTurn = { anchorId: "user-b", targetId: "reply-b" };
  f.notify(); flushFrames();
  expect(f.viewport.calls.filter((call) => call.behavior === "smooth")).toHaveLength(1);
  f.notify(); flushFrames();
  expect(f.viewport.calls.filter((call) => call.behavior === "smooth")).toHaveLength(1);
  dispose();
});

test("first entry still positions a newly submitted turn", () => {
  const f = fixture();
  const dispose = mountTopAnchorReserve(f.store, { current: null });
  flushFrames();
  expect(f.viewport.calls).toEqual([{ top: 1400, behavior: "smooth" }]);
  dispose();
});

test.each([32, 48])("submitted bubbles settle below the computed %ipx safe top edge with matching reserve", (inset) => {
  const f = fixture();
  f.viewport.scrollPaddingTop = `${inset}px`;
  const dispose = mountTopAnchorReserve(f.store, { current: null });
  flushFrames();
  expect(f.anchor.offsetTop - f.viewport.scrollTop).toBe(inset);
  expect(f.viewport.scrollHeight - f.viewport.clientHeight).toBe(f.viewport.scrollTop);
  expect(f.viewport.calls).toEqual([{ top: f.anchor.offsetTop - inset, behavior: "smooth" }]);
  dispose();
});

test("tall user messages retain the clamp below the safe top edge", () => {
  const f = fixture();
  f.viewport.scrollPaddingTop = "32px";
  f.anchor.style.height = "320";
  const dispose = mountTopAnchorReserve(f.store, { current: null });
  flushFrames();
  expect(f.anchor.offsetTop + f.anchor.offsetHeight - f.viewport.scrollTop).toBe(32 + f.state.targetConfig.visibleHeight);
  dispose();
});

test("top padding does not move an existing restored reading position", () => {
  const f = fixture();
  f.viewport.scrollPaddingTop = "32px";
  const dispose = mountTopAnchorReserve(f.store, { current: { scrollTop: 420, topAnchorTurn: f.state.topAnchorTurn } });
  flushFrames();
  expect(f.viewport.calls).toEqual([{ top: 420, behavior: "instant" }]);
  dispose();
});

test("percentage padding uses viewport height and early anchors clamp at zero", () => {
  const f = fixture();
  f.viewport.scrollPaddingTop = "10%";
  const dispose = mountTopAnchorReserve(f.store, { current: null });
  flushFrames();
  expect(f.anchor.offsetTop - f.viewport.scrollTop).toBe(f.viewport.clientHeight / 10);
  f.anchor.dataset.messageId = "early-anchor";
  f.anchor.offsetTop = 12;
  f.notify(); flushFrames();
  expect(f.viewport.scrollTop).toBe(0);
  dispose();
});

test("completed history restores without needing an active anchor", () => {
  const f = fixture();
  Object.assign(f.state, { topAnchorTurn: null, targetConfig: null, element: { viewport: f.viewport, anchor: null, target: null } });
  const dispose = mountTopAnchorReserve(f.store, { current: { scrollTop: 520, topAnchorTurn: null } });
  expect(f.viewport.scrollTop).toBe(520);
  flushFrames();
  expect(f.viewport.calls).toEqual([{ top: 520, behavior: "instant" }]);
  dispose();
});

test("missing message refs defer restoration until the official store registers them", () => {
  const f = fixture();
  Object.assign(f.state.element, { anchor: null, target: null }); f.state.targetConfig = null as never;
  const dispose = mountTopAnchorReserve(f.store, { current: { scrollTop: 760, topAnchorTurn: f.state.topAnchorTurn } });
  expect(f.viewport.calls).toEqual([]);
  Object.assign(f.state.element, { anchor: f.anchor, target: f.target });
  f.state.targetConfig = { tallerThan: 160, visibleHeight: 96 };
  f.notify(); flushFrames();
  expect(f.viewport.calls).toEqual([{ top: 760, behavior: "instant" }]);
  dispose();
});

test("reading snapshots survive page remounts, remain per-session and are pruned on deletion", () => {
  const a = getThreadScrollState("a")!;
  a.current = { scrollTop: 123, topAnchorTurn: null };
  expect(getThreadScrollState("a")).toBe(a);
  expect(getThreadScrollState("b")!.current).toBeNull();
  expect(getThreadScrollState(undefined)).toBeUndefined();
  pruneThreadScrollStates(["b"]);
  expect(getThreadScrollState("a")!.current).toBeNull();
});
