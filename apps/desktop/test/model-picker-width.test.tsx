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
    Element: view.Element, Node: view.Node, NodeFilter: view.NodeFilter, Event: view.Event, CustomEvent: view.CustomEvent,
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

test("before the runtime model list arrives the picker neither guesses parameters nor rewrites the saved model", async () => {
  view.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify([{ id: "provider", name: "Provider", models: [{ id: "a", label: "A" }] }]));
  useStore.setState({ modelConfigs: [], modelConfigsLoaded: false, selectedModelId: "other/saved", currentSessionId: undefined });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModelPicker />));
  expect(container.querySelector(".q-model-picker-trigger")).toBeNull();
  expect(useStore.getState().selectedModelId).toBe("other/saved");
  await act(async () => useStore.setState({ modelConfigsLoaded: true }));
  expect(container.querySelector(".q-model-picker-trigger")).not.toBeNull();
});

test("each conversation keeps its own provider, and the logo switches it for that conversation only", async () => {
  view.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify([
    { id: "alpha", name: "Alpha", models: [{ id: "shared", label: "Shared" }, { id: "a2", label: "A2" }] },
    { id: "beta", name: "Beta", models: [{ id: "b1", label: "B1" }, { id: "shared", label: "Shared" }] },
  ]));
  view.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, "alpha");
  const config = (provider: string, model: string) => ({ id: `${provider}/${model}`, provider, model, config: {}, enabled: true, updatedAt: 1 });
  useStore.setState({
    modelConfigs: [config("alpha", "shared"), config("alpha", "a2"), config("beta", "b1"), config("beta", "shared")],
    modelConfigsLoaded: true, currentSessionId: "s1", selectedModelId: "beta/shared",
    runOptionsBySession: { s1: { modelId: "beta/shared" }, s2: { modelId: "beta/b1" } },
  });
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<ModelPicker />));
  // A model from a provider other than the global default is kept, not reset.
  expect(useStore.getState().selectedModelId).toBe("beta/shared");

  await act(async () => container.querySelector<HTMLButtonElement>(".q-model-picker-trigger")!.click());
  await act(async () => document.querySelector<HTMLButtonElement>(".q-model-picker-provider-button")!.click());
  const alpha = [...document.querySelectorAll<HTMLButtonElement>(".q-model-picker-advanced [role=option]")].find((option) => option.textContent?.includes("Alpha"))!;
  await act(async () => alpha.click());
  // Same model name exists in Alpha, so it is kept; the other conversation is untouched.
  expect(useStore.getState().runOptionsBySession.s1?.modelId).toBe("alpha/shared");
  expect(useStore.getState().runOptionsBySession.s2?.modelId).toBe("beta/b1");
});

test("a team member following the conversation model gets the same picker and can save or reset overrides", async () => {
  const { Dialog } = await import("radix-ui");
  const { BotEditorDialog } = await import("../src/components/team/BotEditorDialog");
  useStore.setState({
    modelConfigsLoaded: true,
    selectedModelId: "alpha/a",
    modelConfigs: [["beta", "b1"], ["beta", "b2"], ["alpha", "a"]].map(([provider, model]) => ({
      id: `${provider}/${model}`, provider, model, config: {}, enabled: true, updatedAt: 1,
    })),
  });
  let saved: { modelId: string; id?: string; thinking?: string } | undefined;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () => root!.render(<Dialog.Root open>
    <Dialog.Content aria-describedby={undefined}>
      <Dialog.Title>Create group</Dialog.Title>
      <BotEditorDialog open nested onOpenChange={() => {}} onSave={({ modelId, thinking }, id) => { saved = { modelId, id, thinking }; }}
        editingBot={{ id: "preset-test", name: "测试成员", roleTitle: "测试", description: "", systemPrompt: "",
          logo: "robot", modelId: "", capabilities: [], source: "preset", createdAt: 1, updatedAt: 1 }} />
    </Dialog.Content>
  </Dialog.Root>));
  const trigger = document.querySelector<HTMLButtonElement>(".team-wizard-footer .q-model-picker-trigger")!;
  expect(trigger).not.toBeNull();
  const click = async (selector: string) => {
    const button = document.querySelector<HTMLButtonElement>(selector);
    expect(button).not.toBeNull();
    await act(async () => button!.click());
  };
  const label = () => trigger.querySelector(".q-model-picker-trigger-name")?.textContent;
  const submit = () => click(".team-wizard-footer .servers-button.is-primary");
  expect(label()).toBe("a");
  expect(trigger.title).toMatch(/默认|default/i);
  await submit(); // 下一步
  await submit();
  expect(saved?.modelId).toBe("");
  await act(async () => trigger.click());
  const panel = document.querySelector(".q-model-picker-simple[data-active=true]");
  expect(panel).not.toBeNull();
  expect(panel?.closest('[aria-hidden="true"]')).toBeNull();
  expect(panel?.querySelector(".q-model-picker-model-name")?.textContent).toBe("a");
  const slider = panel?.querySelector('[role="slider"]');
  expect(slider).not.toBeNull();
  expect(slider?.getAttribute("aria-disabled")).toBeNull();
  const effort = slider?.getAttribute("aria-valuenow");
  const key = effort === slider?.getAttribute("aria-valuemax") ? "Home" : "End";
  await act(async () => { slider?.dispatchEvent(new view.KeyboardEvent("keydown", { key, bubbles: true })); });
  expect(slider?.getAttribute("aria-valuenow")).not.toBe(effort);
  await click(".q-model-picker-reset");
  await act(async () => trigger.click());
  await click(".q-model-picker-provider-button");
  await click(".q-model-picker-advanced [role=option]:first-child");
  expect(label()).toBe("b1");
  await act(async () => trigger.click());
  await click(".q-model-picker-model-button");
  await click(".q-model-picker-advanced [role=option]:last-child");
  expect(label()).toBe("b2");
  await submit();
  expect(saved).toMatchObject({ id: "preset-test", modelId: "beta/b2" });
  await act(async () => trigger.click());
  await click(".q-model-picker-reset");
  expect(label()).toBe("a");
  await submit();
  expect(saved).toMatchObject({ id: "preset-test", modelId: "", thinking: undefined });
  expect(useStore.getState().selectedModelId).toBe("alpha/a");
});
