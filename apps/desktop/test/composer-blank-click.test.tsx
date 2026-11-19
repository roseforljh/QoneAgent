import { afterAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, InputEvent: dom.window.InputEvent, Selection: dom.window.Selection,
  Range: dom.window.Range, MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
  getSelection: dom.window.getSelection.bind(dom.window), IS_REACT_ACT_ENVIRONMENT: true })) {
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
    </ComposerPrimitive.Root>
  </AssistantRuntimeProvider>;
}

test("clicking the input box outside its text keeps the caret instead of jumping to the start", async () => {
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  await act(async () => root.render(<View />));
  await act(async () => { aui.composer().setText("hello world"); });
  // Focus left the input; the draft keeps its caret at the end.
  await act(async () => { (document.activeElement as HTMLElement | null)?.blur(); });
  const blank = host.querySelector<HTMLElement>("[data-blank]")!;
  const event = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
  await act(async () => { blank.dispatchEvent(event); });
  expect(event.defaultPrevented).toBe(true);
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.isCollapsed() && selection.anchor.offset).toBe("hello world".length);
  });
  await act(async () => root.unmount());
});
