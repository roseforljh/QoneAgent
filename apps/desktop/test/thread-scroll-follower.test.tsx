import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, StrictMode, useRef } from "react";
import { captureViewportAnchor, getThreadScrollState, pruneThreadScrollStates, restoreViewportAnchor } from "../src/lib/thread-scroll-state";

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
function Fixture({ sessionId = "mount-order", running = true, messageRoots = false, readingRoots = false }: { sessionId?: string; running?: boolean; messageRoots?: boolean; readingRoots?: boolean }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const runtime = aui.useExternalStoreRuntime({
    messages: [{ id: `user-${sessionId}`, role: "user", content: [{ type: "text", text: "question" }] },
      { id: running ? "streaming" : `reply-${sessionId}`, role: "assistant", content: [{ type: "tool-call", toolName: "read", toolCallId: "t", args: {} }] }],
    adapters: { threadList: { threadId: sessionId } },
    convertMessage: (message) => message,
    isRunning: running, onNew: async () => {},
  });
  return <aui.AssistantRuntimeProvider runtime={runtime}>
    <follower.SessionThreadViewport sessionId={sessionId} data-test-viewport turnAnchor="top"
      scrollToBottomOnInitialize={false} scrollToBottomOnRunStart={false} scrollToBottomOnThreadSwitch={false}>
      <follower.ThreadScrollFollower contentRef={contentRef}>
        <div ref={contentRef} data-test-content>{messageRoots
          ? <aui.ThreadPrimitive.Messages>{({ message }) => <aui.MessagePrimitive.Root className={readingRoots ? "q-message-root" : undefined}>{message.id}</aui.MessagePrimitive.Root>}</aui.ThreadPrimitive.Messages>
          : "tool output"}</div>
        <aui.ThreadPrimitive.ViewportFooter data-thread-scroll-footer><BottomButton /></aui.ThreadPrimitive.ViewportFooter>
      </follower.ThreadScrollFollower>
    </follower.SessionThreadViewport>
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
  if (running) scrollHeight -= 180;
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

test("a session returns to its exact scrollTop even after growing while away", async () => {
  contentHeight = 1200; scrollHeight = 1800;
  useStore.setState({ currentSessionId: "tail-a" });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Fixture sessionId="tail-a" running={false} />); });
  await flush();
  const firstTop = document.querySelector<HTMLElement>("[data-test-viewport]")!.scrollTop;

  await act(async () => {
    useStore.setState({ currentSessionId: "tail-b" });
    root!.render(<Fixture sessionId="tail-b" running={false} />);
  });
  contentHeight = 1500; scrollHeight = 2100;
  await flush();

  await act(async () => {
    useStore.setState({ currentSessionId: "tail-a" });
    root!.render(<Fixture sessionId="tail-a" running={false} />);
  });
  await flush();
  const returned = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  expect(returned.scrollTop).toBe(firstTop);
  // 切回后点击回到底部按钮仍可正常滚到新底部。
  const button = document.querySelector<HTMLButtonElement>("[data-test-bottom]")!;
  await act(async () => { button.click(); });
  expect(returned.scrollTop).toBe(firstTop + 300);
});

test("switching across projects via loading unmount restores the exact scrollTop when returning", async () => {
  contentHeight = 1200; scrollHeight = 1800;
  useStore.setState({ currentSessionId: "proj-a-chat" });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Fixture sessionId="proj-a-chat" running={false} messageRoots />); });
  await flush();
  const a = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  await act(async () => {
    a.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    a.scrollTo({ top: 260 });
  });
  // 模拟切到另一项目的未缓存会话：先卸载视口进入加载态，再挂载另一项目会话。
  await act(async () => {
    useStore.setState({ currentSessionId: "proj-b-chat" });
    root!.render(<div data-loading />);
  });
  await act(async () => {
    root!.render(<Fixture sessionId="proj-b-chat" running={false} messageRoots />);
  });
  await flush();
  const b = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  await act(async () => {
    b.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    b.scrollTo({ top: 510 });
  });
  // 切回原项目会话，即使内容高度已变也依旧停在 260。
  contentHeight = 1500; scrollHeight = 2100;
  await act(async () => {
    useStore.setState({ currentSessionId: "proj-a-chat" });
    root!.render(<Fixture sessionId="proj-a-chat" running={false} messageRoots />);
  });
  await flush();
  expect(document.querySelector<HTMLElement>("[data-test-viewport]")!.scrollTop).toBe(260);
  // 再切回另一项目会话，依旧停在 510。
  await act(async () => {
    useStore.setState({ currentSessionId: "proj-b-chat" });
    root!.render(<Fixture sessionId="proj-b-chat" running={false} messageRoots />);
  });
  await flush();
  expect(document.querySelector<HTMLElement>("[data-test-viewport]")!.scrollTop).toBe(510);
});

test("leaving during a running reply and returning after it finishes restores the exact scrollTop without reserve", async () => {
  contentHeight = 1200; scrollHeight = 1800;
  useStore.setState({ currentSessionId: "finish-a" });
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  await act(async () => { root!.render(<Fixture sessionId="finish-a" running messageRoots />); });
  await flush();
  const a = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  await act(async () => {
    a.dispatchEvent(new view.WheelEvent("wheel", { deltaY: -80, bubbles: true }));
    a.scrollTo({ top: 340 });
  });
  await act(async () => {
    useStore.setState({ currentSessionId: "finish-b" });
    root!.render(<Fixture sessionId="finish-b" running={false} messageRoots />);
  });
  await flush();
  // 切回时 AI 已回复结束（running = false）。
  await act(async () => {
    useStore.setState({ currentSessionId: "finish-a" });
    root!.render(<Fixture sessionId="finish-a" running={false} messageRoots />);
  });
  await flush();
  const returned = document.querySelector<HTMLElement>("[data-test-viewport]")!;
  expect(returned.scrollTop).toBe(340);
  expect(returned.querySelector("[data-aui-top-anchor-reserve]")).toBeNull();
});

test("anchor restoration penetrates content-visibility collapse without clamping to bottom or top-anchor", () => {
  // 模拟 10 轮长对话：离开前每轮 900px，用户停在第 5 轮（index 4）内部 -400px 处（scrollTop = 4000）。
  const createLayout = (collapsed: boolean) => {
    const viewport = document.createElement("div");
    let currentTop = 0;
    const expandedIndices = new Set<number>();
    const heights = () => Array.from({ length: 10 }, (_, i) => (!collapsed || i === 9 || expandedIndices.has(i)) ? 900 : 280);
    const totalHeight = () => heights().reduce((sum, h) => sum + h, 0);
    const blocks = Array.from({ length: 10 }, (_, i) => {
      const el = document.createElement("div");
      el.dataset.messageBlock = "";
      el.dataset.turnId = `turn-${i}`;
      el.getBoundingClientRect = () => {
        const hs = heights();
        const topDoc = hs.slice(0, i).reduce((sum, h) => sum + h, 0);
        const h = hs[i]!;
        return new view.DOMRect(0, topDoc - currentTop, 600, h);
      };
      viewport.append(el);
      return el;
    });
    const revealVisible = () => {
      if (!collapsed) return;
      const hs = heights();
      let y = 0;
      for (let i = 0; i < 10; i++) {
        const h = hs[i]!;
        if (y + h > currentTop && y < currentTop + 600) expandedIndices.add(i);
        y += h;
      }
    };
    Object.defineProperties(viewport, {
      clientHeight: { configurable: true, get: () => 600 },
      scrollHeight: { configurable: true, get: totalHeight },
      scrollTop: {
        configurable: true,
        get: () => currentTop,
        set: (value: number) => {
          currentTop = Math.max(0, Math.min(value, totalHeight() - 600));
          revealVisible();
        },
      },
    });
    viewport.getBoundingClientRect = () => new view.DOMRect(0, 0, 600, 600);
    viewport.scrollTo = ((opts: ScrollToOptions) => { viewport.scrollTop = opts.top ?? 0; }) as typeof viewport.scrollTo;
    return { viewport, blocks };
  };

  // 离开前：完整高度下停在 turn-4 内部 -400px（scrollTop = 4000）。
  const before = createLayout(false);
  before.viewport.scrollTop = 4000;
  const anchor = captureViewportAnchor(before.viewport)!;
  expect(anchor.turnId).toBe("turn-4");
  expect(anchor.offsetPx).toBe(-400);

  // 切回后：新 DOM 上历史轮次被 content-visibility: auto 折叠成 280px（初始 maxScrollTop 仅 2820 < 4000）。
  const after = createLayout(true);
  expect(after.viewport.scrollHeight - after.viewport.clientHeight).toBeLessThan(4000);
  expect(restoreViewportAnchor(after.viewport, anchor)).toBe(true);
  // turn-4 展开真实 900px 高度，且顶边精准落回 -400px，既没有被夹到最底部，也没有漂移到其他轮次。
  const restoredRect = after.blocks[4]!.getBoundingClientRect();
  expect(restoredRect.height).toBe(900);
  expect(restoredRect.top).toBe(-400);
});
