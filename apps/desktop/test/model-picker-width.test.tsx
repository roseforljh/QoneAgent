import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act } from "react";
import { ACTIVE_PROVIDER_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT, PROVIDERS_STORAGE_KEY } from "../src/lib/model-picker-data";

const dom = new JSDOM("<!doctype html><html><body></body></html>", { pretendToBeVisual: true, url: "http://localhost" });
const view = dom.window;
const originals = new Map<string, PropertyDescriptor | undefined>();
let useStore: typeof import("../src/store").useStore;
let initialState: ReturnType<typeof useStore.getState>;
let createRoot: typeof import("react-dom/client").createRoot;
let ModelPicker: typeof import("../src/components/assistant-ui/model-picker").ModelPicker;
let root: ReturnType<typeof createRoot> | undefined;

beforeAll(async () => {
  const globals = {
    window: view, document: view.document, navigator: view.navigator,
    HTMLElement: view.HTMLElement, HTMLInputElement: view.HTMLInputElement,
    Element: view.Element, Node: view.Node, Event: view.Event, CustomEvent: view.CustomEvent,
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
  ({ useStore } = await import("../src/store"));
  initialState = useStore.getState();
  ({ ModelPicker } = await import("../src/components/assistant-ui/model-picker"));
});

afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = undefined;
  useStore.setState(initialState);
  view.localStorage.clear();
  view.document.body.innerHTML = "";
});

afterAll(() => {
  for (const [name, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, name, descriptor);
    else Reflect.deleteProperty(globalThis, name);
  }
  view.close();
});

test("adding a model through picker settings restores intrinsic trigger width without another click", async () => {
  useStore.setState({ modelConfigs: [], selectedModelId: "", currentSessionId: undefined });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModelPicker />));
  const trigger = container.querySelector<HTMLButtonElement>(".q-model-picker-trigger")!;
  // jsdom has no layout; supply a measured width to exercise the real popover lifecycle.
  Object.defineProperty(trigger, "offsetWidth", { configurable: true, value: 120 });
  await act(async () => trigger.click());
  expect(trigger.getAttribute("aria-expanded")).toBe("true");
  expect(trigger.style.width).toBe("120px");

  let settingsOpened = false;
  const onSettings = () => { settingsOpened = true; };
  view.addEventListener("qone-open-settings", onSettings, { once: true });
  try {
    const settings = document.querySelector<HTMLButtonElement>(".q-model-picker-settings")!;
    expect(settings).not.toBeNull();
    await act(async () => settings.click());
    expect(settingsOpened).toBe(true);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");

    await act(async () => {
      view.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify([{
        id: "provider", name: "Provider", models: [{ id: "gpt-6-sol", label: "GPT model with a longer display name" }],
      }]));
      view.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, "provider");
      view.dispatchEvent(new view.Event(MODEL_CONFIG_CHANGE_EVENT));
    });
    expect(trigger.querySelector(".q-model-picker-trigger-name")?.textContent).toBe("GPT model with a longer display name");
    expect(trigger.querySelector(".q-model-picker-effort-label")).not.toBeNull();
    expect(trigger.style.width).toBe("");

    await act(async () => trigger.click());
    expect(trigger.style.width).toBe("120px");
    await act(async () => trigger.click());
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(trigger.style.width).toBe("");
  } finally {
    view.removeEventListener("qone-open-settings", onSettings);
  }
});
