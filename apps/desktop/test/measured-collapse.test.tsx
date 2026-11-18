import { afterAll, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, createElement } from "react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const view = dom.window;
const originals = new Map<string, PropertyDescriptor | undefined>();

beforeAll(() => {
  view.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
  const globals = {
    window: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node,
    getComputedStyle: view.getComputedStyle.bind(view), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
});
afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else delete (globalThis as Record<string, unknown>)[name];
  }
});

test("collapse animates from the measured height without laying the panel out at its target first", async () => {
  const { createRoot } = await import("react-dom/client");
  const { MeasuredCollapse } = await import("../src/components/assistant-ui/elements/measured-collapse");
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const render = (open: boolean) => createElement(MeasuredCollapse, { id: "panel", open }, createElement("p", null, "body"));
  await act(async () => { root.render(render(true)); });
  const panel = document.getElementById("panel")!;
  expect(panel.style.height).toBe("auto");

  // A forced layout at height 0 would clamp the thread scroller. Record every
  // height the panel takes while it is measured and the animation starts.
  const heights: string[] = [];
  const rect = { height: 300 } as DOMRect;
  panel.getBoundingClientRect = () => { heights.push(panel.style.height); return rect; };
  await act(async () => { root.render(render(false)); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 50)); });
  expect(heights).toEqual(["auto"]);
  const midway = Number.parseFloat(panel.style.height);
  expect(midway).toBeGreaterThan(0);
  expect(midway).toBeLessThan(300);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 400)); });
  expect(panel.style.height).toBe("0px");
  expect(panel.getAttribute("aria-hidden")).toBe("true");
  await act(async () => { root.unmount(); });
});
