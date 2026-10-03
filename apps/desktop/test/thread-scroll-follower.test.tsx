import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, StrictMode, useRef } from "react";
import { getThreadScrollState, pruneThreadScrollStates } from "../src/lib/thread-scroll-state";

// Real React ref/effect ordering with deterministic geometry. No browser is used.
const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const view = dom.window;
const originals = new Map<string, PropertyDescriptor | undefined>();
const frames = new Map<number, FrameRequestCallback>();
let nextFrame = 0;
let contentHeight = 300;
let scrollHeight = 1200;
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
let originalSessionId: string | undefined;
beforeAll(async () => {
  const globals: Record<string, unknown> = {
    window: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node,
    MutationObserver: view.MutationObserver, ResizeObserver: ResizeStub,
    getComputedStyle: view.getComputedStyle.bind(view), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: (fn: FrameRequestCallback) => { frames.set(++nextFrame, fn); return nextFrame; },
    cancelAnimationFrame: (id: number) => frames.delete(id),
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  view.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as any;
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
    if (this.hasAttribute("data-thread-scroll-footer")) return new view.DOMRect(0, 500, 600, 100);
    if (this.hasAttribute("data-test-content")) return new view.DOMRect(0, -top, 600, contentHeight);
    return new view.DOMRect(0, 0, 600, 600);
  };
  ({ createRoot } = await import("react-dom/client"));
  aui = await import("@assistant-ui/react");
  follower = await import("../src/components/assistant-ui/thread-scroll-follower");
  ({ useStore } = await import("../src/store"));
  originalSessionId = useStore.getState().currentSessionId;
});
afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  frames.clear(); ResizeStub.instances.clear();
  pruneThreadScrollStates([]);
  useStore.setState({ currentSessionId: originalSessionId });
  document.body.innerHTML = "";
});
afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.window.close();
});

function BottomButton() {
  const control = follower.useThreadBottomControl();
  return <button data-test-bottom data-visible={control.show} onClick={control.scrollToBottom}>Bottom</button>;
}
function Fixture({ sessionId = "mount-order", running = true, messageRoots = false }: { sessionId?: string; running?: boolean; messageRoots?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const runtime = aui.useExternalStoreRuntime({
    messages: [{ id: "u", role: "user", content: [{ type: "text", text: "question" }] },
      { id: "a", role: "assistant", content: [{ type: "tool-call", toolName: "read", toolCallId: "t", args: {} }] }],
    convertMessage: (message) => message,
    isRunning: running, onNew: async () => {},
  });
  return <aui.AssistantRuntimeProvider runtime={runtime}>
    <aui.ThreadPrimitive.Viewport key={sessionId} data-test-viewport turnAnchor="top"
      scrollRestoration={getThreadScrollState(sessionId)}
      scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}>
      <follower.ThreadScrollFollower contentRef={contentRef}>
        <div ref={contentRef} data-test-content>{messageRoots
          ? <aui.ThreadPrimitive.Messages>{({ message }) => <aui.MessagePrimitive.Root>{message.id}</aui.MessagePrimitive.Root>}</aui.ThreadPrimitive.Messages>
          : "tool output"}</div>
        <aui.ThreadPrimitive.ViewportFooter data-thread-scroll-footer><BottomButton /></aui.ThreadPrimitive.ViewportFooter>
      </follower.ThreadScrollFollower>
    </aui.ThreadPrimitive.Viewport>
  </aui.AssistantRuntimeProvider>;
}
async function flush() {
  await act(async () => {
    ResizeStub.change();
    for (let index = 0; frames.size && index < 10; index++) {
      const pending = [...frames.values()]; frames.clear();
      pending.forEach((fn) => fn(performance.now()));
    }
  });
}
async function mount(strict = false) {
  contentHeight = 300; scrollHeight = 1200;
  pruneThreadScrollStates([]);
  useStore.setState({ currentSessionId: "mount-order" });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(strict ? <StrictMode><Fixture /></StrictMode> : <Fixture />); });
  await flush();
  return document.querySelector<HTMLElement>("[data-test-viewport]")!;
}

test("first mount connects the follower after the parent viewport registers, then follows overflow", async () => {
  const viewport = await mount();
  expect(viewport.scrollTop).toBe(0);
  contentHeight = 900;
  await flush();
  expect(viewport.scrollTop).toBe(400);
  expect(document.querySelector("[data-test-bottom]")?.getAttribute("data-visible")).toBe("false");
});

test("a viewport remount reconnects its follower and cleans up the old viewport", async () => {
  const old = await mount();
  await act(async () => {
    useStore.setState({ currentSessionId: "mount-next" });
    root!.render(<Fixture sessionId="mount-next" />);
  });
  contentHeight = 950;
  await flush();
  const viewport = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  expect(viewport).not.toBe(old);
  expect(viewport.scrollTop).toBe(450);
  expect(old.scrollTop).toBe(0);
});

test("manual reading pauses the mounted follower and the bottom button resumes subsequent growth", async () => {
  const viewport = await mount();
  contentHeight = 900; await flush();
  await act(async () => {
    viewport.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    viewport.scrollTo({ top: 320 });
  });
  contentHeight = 1000; await flush();
  expect(viewport.scrollTop).toBe(320);
  const button = document.querySelector<HTMLButtonElement>("[data-test-bottom]")!;
  expect(button.getAttribute("data-visible")).toBe("true");
  await act(async () => { button.click(); });
  expect(viewport.scrollTop).toBe(500);
  contentHeight = 1100; await flush();
  expect(viewport.scrollTop).toBe(600);
  expect(button.getAttribute("data-visible")).toBe("false");
});

test("StrictMode ref/effect replay retains exactly one functioning scroll owner", async () => {
  const viewport = await mount(true);
  contentHeight = 900; await flush();
  expect(viewport.scrollTop).toBe(400);
  await act(async () => { root!.unmount(); }); root = undefined;
  expect(ResizeStub.instances.size).toBe(0);
  expect(frames.size).toBe(0);
});

test.each([false, true])("switching away and back restores the actual reading position (running: %s)", async (running) => {
  contentHeight = 1200; scrollHeight = 1800;
  useStore.setState({ currentSessionId: "reading-a" });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Fixture sessionId="reading-a" running={running} messageRoots />); });
  await flush();
  const a = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  await act(async () => {
    a.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    a.scrollTo({ top: 320 });
  });
  await act(async () => {
    useStore.setState({ currentSessionId: "reading-b" });
    root!.render(<Fixture sessionId="reading-b" running={running} messageRoots />);
  });
  await flush();
  expect(getThreadScrollState("reading-a")?.current?.scrollTop).toBe(320);
  const b = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  await act(async () => {
    b.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    b.scrollTo({ top: 420 });
    useStore.setState({ currentSessionId: "reading-a" });
    root!.render(<Fixture sessionId="reading-a" running={running} messageRoots />);
  });
  await flush();
  expect(document.querySelector<HTMLElement>("[data-test-viewport]")!.scrollTop).toBe(320);
  expect(getThreadScrollState("reading-b")?.current?.scrollTop).toBe(420);
});
