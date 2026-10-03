import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import type { ThreadMessageLike } from "@assistant-ui/react";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true });
const view = dom.window;
const originals = new Map<string, PropertyDescriptor | undefined>();
let createRoot: typeof import("react-dom/client").createRoot;
let aui: typeof import("@assistant-ui/react");
let SessionTimeline: typeof import("../src/components/assistant-ui/session-timeline").SessionTimeline;
let root: ReturnType<typeof createRoot> | undefined;

beforeAll(async () => {
  view.matchMedia = () => ({ matches: true, addEventListener() {}, removeEventListener() {} }) as any;
  const globals = {
    window: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, Element: view.Element, Node: view.Node, CustomEvent: view.CustomEvent,
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
  ({ SessionTimeline } = await import("../src/components/assistant-ui/session-timeline"));
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

test("tool details require a click, retain user choices during growth, and close on completion", async () => {
  let running = true;
  let command = "bun test";
  let completed = false;
  function Message() {
    return <aui.MessagePrimitive.Root><SessionTimeline startIndex={0} endIndex={2} /></aui.MessagePrimitive.Root>;
  }
  function Fixture() {
    const messages: ThreadMessageLike[] = [{
      id: "interactive-group", role: "assistant", status: running ? { type: "running" } : { type: "complete", reason: "stop" },
      content: [
        { type: "tool-call", toolName: "read", toolCallId: "source", args: { path: "src/source.ts" }, result: "done" },
        { type: "tool-call", toolName: "powershell", toolCallId: "command", args: { command }, ...(completed ? { result: "passed" } : {}) },
      ],
    }];
    const runtime = aui.useExternalStoreRuntime({ messages, isRunning: running, convertMessage: (message) => message, onNew: async () => {} });
    return <aui.AssistantRuntimeProvider runtime={runtime}><aui.ThreadPrimitive.Messages components={{ AssistantMessage: Message }} /></aui.AssistantRuntimeProvider>;
  }
  const container = document.createElement("div"); document.body.append(container);
  root = createRoot(container);
  const render = () => act(async () => { root!.render(<Fixture />); });
  const group = () => container.querySelector<HTMLElement>('[data-slot="tool-timeline"]')!;
  const trigger = () => group().querySelector<HTMLButtonElement>("button")!;
  const panel = () => document.getElementById(trigger().getAttribute("aria-controls")!)!;
  const toggle = () => act(async () => { trigger().click(); });
  await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(panel().textContent).toBe("");
  expect(trigger().title).toContain("bun test");

  await toggle();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(panel().textContent).toContain("source.ts");
  expect(panel().textContent).toContain("bun test");
  expect(panel().textContent!.indexOf("source.ts")).toBeLessThan(panel().textContent!.indexOf("bun test"));
  expect(panel().querySelectorAll('[data-slot="tool-call"][data-state="closed"]')).toHaveLength(2);
  command = "bun test regression";
  await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(trigger().title).toContain(command);
  await toggle();
  command = "bun test regression --coverage";
  await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(panel().hasAttribute("inert")).toBe(true);
  await toggle();
  running = false; completed = true;
  await render();
  expect(trigger().getAttribute("aria-expanded")).toBe("false");
  expect(trigger().title).not.toContain(command);
  await toggle();
  expect(trigger().getAttribute("aria-expanded")).toBe("true");
  expect(panel().textContent).toContain(command);
});
