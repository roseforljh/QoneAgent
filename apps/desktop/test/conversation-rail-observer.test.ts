import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { observeConversationRail } from "../src/lib/conversation-rail-observer";

test("scroll and streamed height updates use observer geometry without synchronous DOM rectangles or repeated queries", () => {
  const dom = new JSDOM('<div id="viewport"><div><div data-conversation-rail-content></div><div data-turn-id="a"></div><div data-turn-id="b"></div><div data-turn-id="c"></div><div data-turn-id="d"></div></div></div>');
  const viewport = dom.window.document.getElementById("viewport")!;
  let height = 400;
  Object.defineProperty(viewport, "scrollHeight", { get: () => height });
  Object.defineProperty(viewport, "clientHeight", { value: 200 });
  const blocks = [...viewport.querySelectorAll<HTMLElement>("[data-turn-id]")];
  let queries = 0, rectangles = 0;
  const query = viewport.querySelectorAll.bind(viewport);
  viewport.querySelectorAll = ((selector: string) => { queries++; return query(selector); }) as typeof viewport.querySelectorAll;
  for (const node of [viewport, ...blocks]) node.getBoundingClientRect = () => { rectangles++; throw new Error("forced layout"); };
  let intersectionCallback!: IntersectionObserverCallback, resizeCallback!: ResizeObserverCallback;
  const intersections = new Set<Element>(), resizes = new Set<Element>();
  class IntersectionStub {
    constructor(callback: IntersectionObserverCallback, options: IntersectionObserverInit) { intersectionCallback = callback; expect(options.root).toBe(viewport); }
    observe(node: Element) { intersections.add(node); }
    unobserve(node: Element) { intersections.delete(node); }
    disconnect() { intersections.clear(); }
  }
  class ResizeStub {
    constructor(callback: ResizeObserverCallback) { resizeCallback = callback; }
    observe(node: Element) { resizes.add(node); }
    unobserve(node: Element) { resizes.delete(node); }
    disconnect() { resizes.clear(); }
  }
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ IntersectionObserver: IntersectionStub, ResizeObserver: ResizeStub, getComputedStyle: () => ({ scrollPaddingTop: "0" }) })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key)); Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const updates: { activeId?: string; visibleIds: string[] }[] = [];
  const rail = observeConversationRail(viewport, (value) => updates.push(value));
  try {
    expect(intersections.size).toBe(4); expect(queries).toBe(1);
    intersectionCallback(blocks.map((target, index) => ({ target, rootBounds: { top: 0, bottom: 200 }, boundingClientRect: { top: index * 100, bottom: index * 100 + 100 } })) as IntersectionObserverEntry[], {} as IntersectionObserver);
    expect(updates.at(-1)).toEqual({ activeId: "a", visibleIds: ["a", "b"] });
    viewport.scrollTop = 150; viewport.dispatchEvent(new dom.window.Event("scroll"));
    expect(updates.at(-1)).toEqual({ activeId: "d", visibleIds: ["b", "c", "d"] });
    height = 500;
    resizeCallback([{ target: blocks[0]!, borderBoxSize: [{ blockSize: 200 }] }] as ResizeObserverEntry[], {} as ResizeObserver);
    expect(updates.at(-1)).toEqual({ activeId: "b", visibleIds: ["a", "b", "c"] });
    for (let index = 0; index < 200; index++) {
      height++; resizeCallback([{ target: blocks[3]!, borderBoxSize: [{ blockSize: 101 + index }] }] as ResizeObserverEntry[], {} as ResizeObserver);
      viewport.dispatchEvent(new dom.window.Event("scroll"));
    }
    expect(rectangles).toBe(0); expect(queries).toBe(1);
    blocks[0]!.remove(); rail.refresh();
    expect(intersections.has(blocks[0]!)).toBe(false); expect(resizes.has(blocks[0]!)).toBe(false);
    expect(queries).toBe(2);
    rail.dispose(); expect(intersections.size).toBe(0); expect(resizes.size).toBe(0);
    const count = updates.length; viewport.dispatchEvent(new dom.window.Event("scroll")); expect(updates).toHaveLength(count);
  } finally {
    rail.dispose(); dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
