import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";
import { useStore } from "../src/store";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const view = dom.window;
const originals = new Map<string, PropertyDescriptor | undefined>();
let createRoot: typeof import("react-dom/client").createRoot;
let aui: typeof import("@assistant-ui/react");
let AssistantParts: typeof import("../src/components/assistant-ui/assistant-parts").AssistantParts;
let assistantMessageContent: typeof import("../src/lib/assistant-message-parts").assistantMessageContent;
let root: ReturnType<typeof createRoot> | undefined;

beforeAll(async () => {
  view.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) as any;
  const globals = {
    window: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node,
    MutationObserver: view.MutationObserver,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    getComputedStyle: view.getComputedStyle.bind(view), IS_REACT_ACT_ENVIRONMENT: true,
    requestAnimationFrame: view.requestAnimationFrame.bind(view),
    cancelAnimationFrame: view.cancelAnimationFrame.bind(view),
  };
  for (const [name, value] of Object.entries(globals)) {
    originals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
    Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
  }
  ({ createRoot } = await import("react-dom/client"));
  aui = await import("@assistant-ui/react");
  ({ AssistantParts } = await import("../src/components/assistant-ui/assistant-parts"));
  ({ assistantMessageContent } = await import("../src/lib/assistant-message-parts"));
});

afterEach(async () => {
  if (root) await act(async () => { root!.unmount(); });
  root = undefined;
  document.body.innerHTML = "";
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  dom.window.close();
});

test("execution collapses as soon as streamed conclusion starts and hands off animation across streaming ID replacement", async () => {
  const previous = useStore.getState();
  const originalRect = view.HTMLElement.prototype.getBoundingClientRect;
  // 让执行过程主体在 JSDOM 中具有非零测量高度，便于验证卸载续播。
  view.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("q-execution-sticky-status")) return new view.DOMRect(0, 0, 400, 180);
    return originalRect.call(this);
  };

  let running = true;
  let messageId = "streaming";
  let parts: Parameters<typeof assistantMessageContent>[0]["parts"] = [
    { type: "text", text: "正在读取代码", phase: "commentary", messageSequence: 1 },
    { type: "tool-call", toolCallId: "t1", toolName: "read", args: { path: "src/app.ts" }, messageSequence: 1 },
  ];
  let streamingText = "";

  function Message() {
    return <aui.MessagePrimitive.Root><AssistantParts /></aui.MessagePrimitive.Root>;
  }
  function Fixture() {
    const content = assistantMessageContent({ content: streamingText, parts }, [], running);
    const messages: ThreadMessageLike[] = [{
      id: messageId, role: "assistant",
      status: running ? { type: "running" } : { type: "complete", reason: "stop" },
      content,
    }];
    const runtime = aui.useExternalStoreRuntime({ messages, isRunning: running, convertMessage: (m) => m, onNew: async () => {} });
    return <aui.AssistantRuntimeProvider runtime={runtime}>
      <aui.ThreadPrimitive.Messages components={{ AssistantMessage: Message }} />
    </aui.AssistantRuntimeProvider>;
  }

  try {
    useStore.setState({
      currentSessionId: "s-collapse",
      activeRunId: "run-collapse",
      runs: [{ id: "run-collapse", sessionId: "s-collapse", status: "running", startedAt: 1 }],
      toolCalls: [{ toolCallId: "t1", toolName: "read", runId: "run-collapse", status: "running", args: { path: "src/app.ts" } }],
      messages: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    const render = () => act(async () => { root!.render(<Fixture />); });

    await render();
    expect(container.querySelector('[data-slot="assistant-execution"] [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open");
    expect(container.textContent).toContain("正在读取代码");

    // 工具执行结束并开始流式输出结论时，执行过程立即进入收起状态且结论在外部渲染。
    parts = [
      { type: "text", text: "正在读取代码", phase: "commentary", messageSequence: 1 },
      { type: "tool-call", toolCallId: "t1", toolName: "read", args: { path: "src/app.ts" }, result: "ok", messageSequence: 1 },
    ];
    streamingText = "最终结论已经就绪。";
    await act(async () => {
      useStore.setState({ toolCalls: [{ toolCallId: "t1", toolName: "read", runId: "run-collapse", status: "success", args: { path: "src/app.ts" }, result: "ok" }] });
      root!.render(<Fixture />);
    });

    const toggle = container.querySelector<HTMLButtonElement>('[aria-label="Expand or collapse execution details"]')!;
    expect(toggle).not.toBeNull();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(container.textContent).toContain("最终结论已经就绪。");
    expect(container.querySelector(".q-execution-sticky-status")).not.toBeNull();

    // 若运行紧接着完成并把 "streaming" 替换为持久化 ID，仍应接力保留收起动画容器而非直接硬切消失。
    running = false;
    messageId = "persisted-msg-1";
    parts = [
      ...parts,
      { type: "text", text: "最终结论已经就绪。", phase: "final_answer", messageSequence: 2 },
    ];
    streamingText = "";
    await act(async () => {
      useStore.setState({
        activeRunId: undefined,
        runs: [{ id: "run-collapse", sessionId: "s-collapse", status: "completed", startedAt: 1, completedAt: 100 }],
        messages: [{ id: "persisted-msg-1", role: "assistant", content: "最终结论已经就绪。", parts, runId: "run-collapse", createdAt: 100 }],
      });
      root!.render(<Fixture />);
    });

    expect(container.querySelector('[data-message-id="persisted-msg-1"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand or collapse execution details"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".q-execution-sticky-status")).not.toBeNull();
  } finally {
    view.HTMLElement.prototype.getBoundingClientRect = originalRect;
    await act(async () => { useStore.setState(previous); });
  }
});

test("instant completion from open streaming directly to persisted message still plays collapse animation", async () => {
  const previous = useStore.getState();
  const originalRect = view.HTMLElement.prototype.getBoundingClientRect;
  view.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.classList.contains("q-execution-sticky-status")) return new view.DOMRect(0, 0, 400, 200);
    return originalRect.call(this);
  };

  let running = true;
  let messageId = "streaming";
  let parts: Parameters<typeof assistantMessageContent>[0]["parts"] = [
    { type: "tool-call", toolCallId: "t2", toolName: "read", args: { path: "src/b.ts" }, result: "ok", messageSequence: 1 },
  ];

  function Message() {
    return <aui.MessagePrimitive.Root><AssistantParts /></aui.MessagePrimitive.Root>;
  }
  function Fixture() {
    const content = assistantMessageContent({ content: "", parts }, [], running);
    const messages: ThreadMessageLike[] = [{
      id: messageId, role: "assistant",
      status: running ? { type: "running" } : { type: "complete", reason: "stop" },
      content,
    }];
    const runtime = aui.useExternalStoreRuntime({ messages, isRunning: running, convertMessage: (m) => m, onNew: async () => {} });
    return <aui.AssistantRuntimeProvider runtime={runtime}>
      <aui.ThreadPrimitive.Messages components={{ AssistantMessage: Message }} />
    </aui.AssistantRuntimeProvider>;
  }

  try {
    useStore.setState({
      currentSessionId: "s-instant",
      activeRunId: "run-instant",
      runs: [{ id: "run-instant", sessionId: "s-instant", status: "running", startedAt: 1 }],
      toolCalls: [{ toolCallId: "t2", toolName: "read", runId: "run-instant", status: "success", args: { path: "src/b.ts" }, result: "ok" }],
      messages: [],
    });
    const container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);

    await act(async () => { root!.render(<Fixture />); });
    expect(container.querySelector('[data-slot="assistant-execution"] [data-slot="collapsible"]')?.getAttribute("data-state")).toBe("open");

    running = false;
    messageId = "persisted-msg-2";
    parts = [
      ...parts,
      { type: "text", text: "好。", phase: "final_answer", messageSequence: 2 },
    ];
    await act(async () => {
      useStore.setState({
        activeRunId: undefined,
        runs: [{ id: "run-instant", sessionId: "s-instant", status: "completed", startedAt: 1, completedAt: 50 }],
        messages: [{ id: "persisted-msg-2", role: "assistant", content: "好。", parts, runId: "run-instant", createdAt: 50 }],
      });
      root!.render(<Fixture />);
    });

    expect(container.querySelector('[data-message-id="persisted-msg-2"]')).not.toBeNull();
    expect(container.querySelector('[aria-label="Expand or collapse execution details"]')?.getAttribute("aria-expanded")).toBe("false");
    expect(container.querySelector(".q-execution-sticky-status")).not.toBeNull();
  } finally {
    view.HTMLElement.prototype.getBoundingClientRect = originalRect;
    await act(async () => { useStore.setState(previous); });
  }
});
