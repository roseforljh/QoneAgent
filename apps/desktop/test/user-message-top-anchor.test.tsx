import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useRef } from "react";
import { pruneThreadScrollStates } from "../src/lib/thread-scroll-state";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const view = dom.window;
const originals = new Map<string, PropertyDescriptor | undefined>();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let contentHeight = 800;
let scrollHeight = 1600;

class ResizeStub {
  static instances = new Set<ResizeStub>();
  observed = new Set<Element>();
  constructor(private callback: ResizeObserverCallback) { ResizeStub.instances.add(this); }
  observe(element: Element) { this.observed.add(element); }
  unobserve(element: Element) { this.observed.delete(element); }
  disconnect() { this.observed.clear(); ResizeStub.instances.delete(this); }
  static change() {
    for (const instance of [...this.instances]) {
      const entries = [...instance.observed].map((target) => ({ target, contentRect: target.getBoundingClientRect() }));
      if (entries.length) instance.callback(entries as ResizeObserverEntry[], instance as unknown as ResizeObserver);
    }
  }
}

let createRoot: typeof import("react-dom/client").createRoot;
let aui: typeof import("@assistant-ui/react");
let follower: typeof import("../src/components/assistant-ui/thread-scroll-follower");
let useStore: typeof import("../src/store").useStore;
let root: ReturnType<typeof import("react-dom/client").createRoot> | undefined;

beforeAll(async () => {
  const globals: Record<string, unknown> = {
    window: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node,
    MutationObserver: view.MutationObserver, ResizeObserver: ResizeStub,
    getComputedStyle: (el: any) => ({
      scrollPaddingTop: "32px",
      overflowY: "auto",
    }),
    IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  view.getComputedStyle = (el: any) => ({
    scrollPaddingTop: "32px",
    overflowY: "auto",
  }) as any;
  view.HTMLElement.prototype.scrollTo = function (options: ScrollToOptions) {
    this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight));
    this.dispatchEvent(new view.Event("scroll"));
  } as typeof view.HTMLElement.prototype.scrollTo;
  Object.defineProperties(view.HTMLElement.prototype, {
    clientHeight: { configurable: true, get() { return this.hasAttribute("data-test-viewport") ? 600 : 100; } },
    scrollHeight: { configurable: true, get() { return scrollHeight; } },
  });
  view.HTMLElement.prototype.getBoundingClientRect = function () {
    const top = this.closest("[data-test-viewport]")?.scrollTop ?? 0;
    if (this.hasAttribute("data-test-viewport")) return new view.DOMRect(0, 0, 600, 600);
    if (this.hasAttribute("data-thread-scroll-footer")) return new view.DOMRect(0, 500, 600, 100);
    if (this.hasAttribute("data-message-id")) {
      const msgTop = this.getAttribute("data-message-id") === "u1" ? 100 : 700;
      return new view.DOMRect(0, msgTop - top, 600, 80);
    }
    return new view.DOMRect(0, -top, 600, contentHeight);
  };
  ({ createRoot } = await import("react-dom/client"));
  aui = await import("@assistant-ui/react");
  follower = await import("../src/components/assistant-ui/thread-scroll-follower");
  ({ useStore } = await import("../src/store"));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  frames.clear(); ResizeStub.instances.clear();
  pruneThreadScrollStates([]);
  document.body.innerHTML = "";
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.window.close();
});

test("sending a new user message automatically pins it to the top edge and does not immediately jump to bottom", async () => {
  let runtimeMessages: any[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: "first" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }], status: { type: "complete", reason: "stop" } },
  ];
  let isRunning = false;

  function Fixture() {
    const contentRef = useRef<HTMLDivElement>(null);
    const runtime = aui.useExternalStoreRuntime({
      messages: runtimeMessages,
      isRunning,
      convertMessage: (m) => m,
      onNew: async () => {},
    });
    return (
      <aui.AssistantRuntimeProvider runtime={runtime}>
        <aui.ThreadPrimitive.Viewport data-test-viewport turnAnchor="top"
          scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}>
          <follower.ThreadScrollFollower contentRef={contentRef}>
            <div ref={contentRef} data-test-content>
              {runtimeMessages.map((m) => (
                <div key={m.id} className={m.role === "user" ? "q-message-user" : "q-message-assistant"} data-message-id={m.id}>
                  {m.id}
                </div>
              ))}
            </div>
            <aui.ThreadPrimitive.ViewportFooter data-thread-scroll-footer>
              Footer
            </aui.ThreadPrimitive.ViewportFooter>
          </follower.ThreadScrollFollower>
        </aui.ThreadPrimitive.Viewport>
      </aui.AssistantRuntimeProvider>
    );
  }

  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);

  await act(async () => {
    root!.render(<Fixture />);
  });

  const viewport = document.querySelector<HTMLElement>("[data-test-viewport]")!;

  // Now user sends a new message: u2
  runtimeMessages = [
    ...runtimeMessages,
    { id: "u2", role: "user", content: [{ type: "text", text: "second question" }] },
    { id: "streaming", role: "assistant", content: [{ type: "text", text: "thinking" }], status: { type: "running" } },
  ];
  isRunning = true;

  await act(async () => {
    root!.render(<Fixture />);
  });

  // Target for u2 (msgTop 700 - topInset 32 = 668)
  expect(viewport.scrollTop).toBe(668);

  // Next animation frame flushes
  await act(async () => {
    ResizeStub.change();
    for (let index = 0; frames.size && index < 10; index++) {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((fn) => fn(performance.now()));
    }
  });

  // CRITICAL: Next frame must NOT have yanked the viewport down to the bottom (1000)
  // It must stay anchored at the user message top (668)!
  expect(viewport.scrollTop).toBe(668);
});
