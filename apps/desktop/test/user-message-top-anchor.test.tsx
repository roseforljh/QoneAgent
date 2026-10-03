import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import type { ThreadMessageLike } from "@assistant-ui/react";
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

test("pending user messages remain visible before the assistant pair exists", async () => {
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
  ];
  isRunning = false;

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

test.each([80, 320])("real message primitives own placement and response reserve (user height %ipx)", async (userHeight) => {
  const viewportTop = 80;
  const userTop = 700;
  let replyHeight = 40;
  let running = false;
  let messages: ThreadMessageLike[] = [
    { id: "u1", role: "user", content: [{ type: "text", text: "first" }] },
    { id: "a1", role: "assistant", content: [{ type: "text", text: "answer" }] },
  ];
  const calls: ScrollToOptions[] = [];
  const reserveHeight = () => Number.parseFloat(document.querySelector<HTMLElement>("[data-aui-top-anchor-reserve]")?.style.height ?? "0");
  const tail = () => userTop + userHeight + replyHeight;
  Object.defineProperties(view.HTMLElement.prototype, {
    offsetParent: { configurable: true, get() { return this.hasAttribute("data-message-id") ? this.closest("[data-test-viewport]") : null; } },
    offsetTop: { configurable: true, get() { return this.hasAttribute("data-test-viewport") ? viewportTop : this.dataset.messageId === "u2" ? userTop : this.dataset.messageId === "a2" ? userTop + userHeight : 100; } },
    offsetHeight: { configurable: true, get() { return this.hasAttribute("data-aui-top-anchor-reserve") ? Number.parseFloat(this.style.height) : this.dataset.messageId === "u2" ? userHeight : replyHeight; } },
    scrollHeight: { configurable: true, get() { return Math.max(600, tail() + 100 + reserveHeight()); } },
  });
  view.HTMLElement.prototype.getBoundingClientRect = function () {
    const scroll = this.closest("[data-test-viewport]")?.scrollTop ?? 0;
    if (this.hasAttribute("data-test-viewport")) return new view.DOMRect(0, viewportTop, 600, 600);
    if (this.hasAttribute("data-thread-scroll-footer")) return new view.DOMRect(0, viewportTop + 500, 600, 100);
    if (this.hasAttribute("data-message-id")) return new view.DOMRect(0, viewportTop + this.offsetTop - scroll, 600, this.offsetHeight);
    if (this.hasAttribute("data-aui-top-anchor-reserve")) return new view.DOMRect(0, viewportTop + tail() - scroll, 600, reserveHeight());
    return new view.DOMRect(0, viewportTop - scroll, 600, tail() + reserveHeight());
  };
  view.HTMLElement.prototype.scrollTo = function (options: ScrollToOptions) {
    calls.push(options);
    this.scrollTop = Math.max(0, Math.min(options.top ?? 0, this.scrollHeight - this.clientHeight));
    this.dispatchEvent(new view.Event("scroll"));
  } as typeof view.HTMLElement.prototype.scrollTo;
  function Fixture() {
    const contentRef = useRef<HTMLDivElement>(null);
    const runtime = aui.useExternalStoreRuntime({ messages, isRunning: running, convertMessage: (m) => m, onNew: async () => {} });
    return <aui.AssistantRuntimeProvider runtime={runtime}>
      <aui.ThreadPrimitive.Viewport data-test-viewport turnAnchor="top"
        scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}>
        <follower.ThreadScrollFollower contentRef={contentRef}>
          <div ref={contentRef} data-test-content>
            <aui.ThreadPrimitive.Messages>{({ message }) => (
              <aui.MessagePrimitive.Root className={message.role === "user" ? "q-message-user" : "q-message-assistant"}>{message.id}</aui.MessagePrimitive.Root>
            )}</aui.ThreadPrimitive.Messages>
          </div>
          <aui.ThreadPrimitive.ViewportFooter data-thread-scroll-footer>Footer</aui.ThreadPrimitive.ViewportFooter>
        </follower.ThreadScrollFollower>
      </aui.ThreadPrimitive.Viewport>
    </aui.AssistantRuntimeProvider>;
  }
  const flush = async () => act(async () => {
    ResizeStub.change();
    for (let index = 0; frames.size && index < 20; index++) {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((fn) => fn(performance.now()));
    }
    expect(frames.size).toBe(0);
  });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Fixture />); });
  await flush();
  calls.length = 0;
  messages = [...messages,
    { id: "u2", role: "user", content: [{ type: "text", text: "second" }] },
    { id: "a2", role: "assistant", content: [{ type: "text", text: "Working", parentId: "pi:phase:commentary:1" }], status: { type: "running" } },
  ];
  running = true;
  await act(async () => { root!.render(<Fixture />); });
  // No fallback instant jump before the primitive has measured its reserve.
  expect(calls).toEqual([]);
  await flush();
  const viewport = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  const user = document.querySelector<HTMLElement>('[data-message-id="u2"]')!;
  const visibleHeight = userHeight <= 160 ? userHeight : 96;
  expect(user.getBoundingClientRect().bottom).toBe(viewportTop + 32 + visibleHeight);
  expect(reserveHeight()).toBeGreaterThan(0);
  expect(calls).toEqual([{ top: userTop + userHeight - visibleHeight - 32, behavior: "smooth" }]);
  const oldReserve = reserveHeight();
  const oldTop = viewport.scrollTop;
  replyHeight += 60;
  await flush();
  expect(reserveHeight()).toBe(oldReserve - 60);
  expect(viewport.scrollTop).toBe(oldTop);

  // Once actual activity reaches the footer, the same mounted controller follows.
  replyHeight += 600;
  await flush();
  expect(viewport.scrollTop).toBe(tail() - 500);
  const userReadingTop = viewport.scrollTop - 80;
  await act(async () => {
    viewport.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    viewport.scrollTo({ top: userReadingTop });
  });
  replyHeight += 100;
  await flush();
  expect(viewport.scrollTop).toBe(userReadingTop);
});
