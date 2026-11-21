import { afterAll, afterEach, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";

const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
const saved = new Map<string, PropertyDescriptor | undefined>();
class LayoutObserver { observe() {} unobserve() {} disconnect() {} }
for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
  HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, Text: dom.window.Text, Event: dom.window.Event,
  MouseEvent: dom.window.MouseEvent, KeyboardEvent: dom.window.KeyboardEvent, InputEvent: dom.window.InputEvent, Selection: dom.window.Selection,
  CustomEvent: dom.window.CustomEvent, Range: dom.window.Range, MutationObserver: dom.window.MutationObserver,
  ResizeObserver: LayoutObserver, IntersectionObserver: LayoutObserver,
  getComputedStyle: dom.window.getComputedStyle.bind(dom.window), getSelection: dom.window.getSelection.bind(dom.window),
  requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window), cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
  IS_REACT_ACT_ENVIRONMENT: true })) {
  saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
}
// jsdom has no layout; Lexical scrolls the caret into view after placing it.
dom.window.Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, right: 0, bottom: 0, left: 0, toJSON: () => ({}) });
dom.window.Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
dom.window.HTMLElement.prototype.scrollTo = function (options: ScrollToOptions) { this.scrollTop = options.top ?? 0; };
const { createRoot } = await import("react-dom/client");
const { AssistantRuntimeProvider, ComposerPrimitive, useAui, useExternalStoreRuntime } = await import("@assistant-ui/react");
const { LexicalComposerInput } = await import("@assistant-ui/react-lexical");
const { useLexicalComposerContext } = await import("@lexical/react/LexicalComposerContext");
const { $getRoot, $getSelection, $isRangeSelection, $isTextNode, $setSelection } = await import("lexical");
const { Thread } = await import("../src/components/assistant-ui/Thread");
const { AnyFileAttachmentAdapter } = await import("../src/lib/file-attachment-adapter");
const { ComposerEditorBridge } = await import("../src/components/assistant-ui/composer-editor-bridge");
const { ComposerDirectiveChip } = await import("../src/components/assistant-ui/composer-link-chip");
const { composerLinkFormatter } = await import("../src/components/assistant-ui/composer-link-formatter");
const { serializeInlineQuote } = await import("../src/lib/inline-quote");
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
      <LexicalComposerInput submitMode="none" formatter={composerLinkFormatter} directiveChip={ComposerDirectiveChip}>
        <ComposerEditorBridge /><Capture />
      </LexicalComposerInput>
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

test("quote controls do not steal the caret, and blank clicks restore it after blur", async () => {
  const host = await renderComposer();
  await act(async () => { aui.composer().setText(`before ${serializeInlineQuote("quoted line")} after`); });
  let key: string;
  await act(async () => editor.update(() => {
    const suffix = $getRoot().getLastDescendant();
    if (!$isTextNode(suffix)) throw new Error("missing text after quote");
    key = suffix.getKey();
    suffix.select(3, 3);
  }, { discrete: true }));
  for (const selector of [".q-composer-quote-trigger", ".q-composer-quote-remove"]) {
    const press = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 });
    await act(async () => host.querySelector(selector)!.dispatchEvent(press));
    expect(press.defaultPrevented).toBe(true);
  }
  await act(async () => {
    editor.blur();
    editor.update(() => $setSelection(null), { discrete: true });
  });
  await act(async () => host.querySelector("[data-blank]")!.dispatchEvent(
    new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }),
  ));
  editor.getEditorState().read(() => {
    const selection = $getSelection();
    expect($isRangeSelection(selection) && selection.anchor).toMatchObject({ key, offset: 3 });
  });
  await act(async () => { aui.composer().setQuote({ text: "another quote", messageId: "source" }); });
  expect(aui.composer().getState().text).toBe(`before ${serializeInlineQuote("quoted line")} af${serializeInlineQuote("another quote")} ter`);
});

function DropThread() {
  const runtime = useExternalStoreRuntime({ messages: [{ id: "user", role: "user", content: "Draft message" }] as const,
    convertMessage: (message) => message, isRunning: false, onNew: async () => {}, adapters: { attachments: new AnyFileAttachmentAdapter() } });
  return <AssistantRuntimeProvider runtime={runtime}><Thread><div data-conversation-content /></Thread></AssistantRuntimeProvider>;
}

test("the conversation shows a drop overlay only for file drags and attaches once", async () => {
  const styles = document.createElement("style");
  styles.textContent = await Bun.file(new URL("../src/components/assistant-ui/thread-viewport.css", import.meta.url)).text();
  document.body.append(styles);
  useStore.setState({ workspaces: [{ id: "project", name: "Project", path: "C:/Project", createdAt: 0, updatedAt: 0 }],
    currentSessionId: undefined, draftWorkspaceId: "project", sessionsLoaded: true, workspacesLoaded: true });
  const host = document.createElement("div"); document.body.append(host);
  root = createRoot(host);
  await act(async () => root!.render(<DropThread />));
  const thread = host.querySelector(".aui-thread-root")!;
  const content = thread.querySelector("[data-conversation-content]")!;
  expect(content.closest(".aui-composer-root")).toBeNull();
  const drag = async (target: Element, type: string, types: string[], files: File[] = []) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: { types, files } });
    await act(async () => target.dispatchEvent(event));
    return event.defaultPrevented;
  };
  const overlay = thread.querySelector(".q-thread-drop-overlay")!;
  const visibility = () => getComputedStyle(overlay).visibility;
  expect(overlay.textContent).toMatch(/松开鼠标添加附件|Drop to add attachments/);
  expect(getComputedStyle(overlay).pointerEvents).toBe("none");
  expect(await drag(content, "dragover", ["text/plain"])).toBe(false);
  expect(visibility()).toBe("hidden");
  expect(await drag(content, "dragover", ["Files"])).toBe(true);
  expect(visibility()).toBe("visible");
  await drag(content, "dragleave", ["Files"]);
  expect(visibility()).toBe("hidden");
  await drag(content, "dragover", ["Files"]);
  expect(await drag(content, "drop", ["Files"], [new File(["text"], "transcript.txt")])).toBe(true);
  expect(visibility()).toBe("hidden");
  const shell = host.querySelector('[data-slot="aui_composer-shell"]')!;
  expect(shell.textContent?.match(/transcript\.txt/g)).toHaveLength(1);
});
