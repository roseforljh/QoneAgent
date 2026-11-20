import { afterAll, afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, InputEvent: dom.window.InputEvent, Selection: dom.window.Selection,
  CustomEvent: dom.window.CustomEvent, Range: dom.window.Range, MutationObserver: dom.window.MutationObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), getSelection: dom.window.getSelection.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
// jsdom has no layout; Lexical scrolls the caret into view after placing it.
dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
const { createRoot } = await import("react-dom/client");
const { AssistantRuntimeProvider, ComposerPrimitive, useAui, useExternalStoreRuntime } = await import("@assistant-ui/react");
const { LexicalComposerInput } = await import("@assistant-ui/react-lexical");
const { useLexicalComposerContext } = await import("@lexical/react/LexicalComposerContext");
const { $getSelection, $isRangeSelection } = await import("lexical");
const { ComposerEditorBridge } = await import("../src/components/assistant-ui/composer-editor-bridge");
const { ModelPicker } = await import("../src/components/assistant-ui/model-picker");
const { useStore } = await import("../src/store");
const originalState = useStore.getState();
let root: ReturnType<typeof createRoot> | undefined;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  useStore.setState(originalState);
  dom.window.localStorage.clear();
  document.body.replaceChildren();
});
afterAll(() => {
  dom.window.close();
  for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
});

let aui: ReturnType<typeof useAui>;
let editor: ReturnType<typeof useLexicalComposerContext>[0];
function Capture() { aui = useAui(); [editor] = useLexicalComposerContext(); return null; }
function View() {
  const runtime = useExternalStoreRuntime({ messages: [], isRunning: false, onNew: async () => {} });
  return <AssistantRuntimeProvider runtime={runtime}>
    <ComposerPrimitive.Root className="aui-composer-root">
      <div data-blank style={{ height: 24 }} />
      <LexicalComposerInput submitMode="none"><ComposerEditorBridge /><Capture /></LexicalComposerInput>
      <ModelPicker />
    </ComposerPrimitive.Root>
  </AssistantRuntimeProvider>;
}

async function renderComposer() {
  useStore.setState({
    currentSessionId: undefined,
    selectedModelId: "provider/alpha",
    modelConfigsLoaded: true,
    modelConfigs: ["alpha", "beta"].map((model) => ({
      id: `provider/${model}`, provider: "provider", model, config: { apiType: "openai-compatible" }, enabled: true, updatedAt: 0,
    })),
  });
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<View />));
  return host;
}

test("choosing a model closes the entire picker, including when reselecting it", async () => {
  const host = await renderComposer();
  const trigger = host.querySelector<HTMLButtonElement>(".q-model-picker-trigger")!;
  for (const wasSelected of [false, true]) {
    await act(async () => trigger.click());
    await act(async () => document.querySelector<HTMLButtonElement>(".q-model-picker-model-button")!.click());
    const option = [...document.querySelectorAll<HTMLButtonElement>('[role="option"]')].find((item) => item.textContent === "beta")!;
    expect(option.getAttribute("aria-selected")).toBe(String(wasSelected));
    await act(async () => option.click());
    expect(useStore.getState().draftRunOptions.modelId).toBe("provider/beta");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(document.querySelector(".q-model-picker-card")).toBeNull();
  }
});

test("clicking composer blank space closes the effort panel and keeps the draft caret", async () => {
  const host = await renderComposer();
  await act(async () => { aui.composer().setText("hello world"); });
  const trigger = host.querySelector<HTMLButtonElement>(".q-model-picker-trigger")!;
  await act(async () => trigger.click());
  // Radix installs its document pointer listener after the opening event.
  await act(async () => { await new Promise((resolve) => dom.window.setTimeout(resolve, 0)); });
  expect(document.querySelector('.q-model-picker-simple[data-active="true"]')).not.toBeNull();
  const blank = host.querySelector<HTMLElement>("[data-blank]")!;
  const mouseDown = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    blank.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true, pointerType: "mouse" }));
    blank.dispatchEvent(mouseDown);
    blank.dispatchEvent(new dom.window.PointerEvent("pointerup", { bubbles: true, pointerType: "mouse" }));
    blank.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
    blank.click();
  });
  expect(trigger.getAttribute("aria-expanded")).toBe("false");
  expect(mouseDown.defaultPrevented).toBe(true);
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.isCollapsed() && selection.anchor.offset).toBe("hello world".length);
  });
});
