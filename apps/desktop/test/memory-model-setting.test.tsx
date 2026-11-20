import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { act, useState } from "react";

test("memory picker distinguishes providers without changing the chat model", async () => {
  const dom = new JSDOM("<!doctype html><body></body>", { pretendToBeVisual: true, url: "https://qone.local" });
  const saved = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries({ window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    HTMLElement: dom.window.HTMLElement, Element: dom.window.Element, Node: dom.window.Node, CustomEvent: dom.window.CustomEvent,
    MutationObserver: dom.window.MutationObserver, getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
    IS_REACT_ACT_ENVIRONMENT: true })) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  const { createRoot } = await import("react-dom/client");
  const { useStore } = await import("../src/store");
  const { MemoryModelSetting } = await import("../src/components/settings/memory/memory-model-setting");
  const initial = useStore.getState();
  const picked: (string | null)[] = [];
  function Fixture() {
    const [id, setId] = useState<string>();
    return <MemoryModelSetting modelId={id} disabled={false} onChange={(next) => { picked.push(next); setId(next ?? undefined); }} />;
  }
  useStore.setState({ selectedModelId: "alpha/shared", modelConfigsLoaded: true,
    modelConfigs: ["alpha", "beta", "images"].map(provider => ({ id: `${provider}/shared`, provider, model: "shared", enabled: true, updatedAt: 0,
      config: { output: [provider === "images" ? "image" : "text"] } })) });
  const host = document.createElement("div"); document.body.append(host);
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Fixture />));
    const trigger = host.querySelector<HTMLButtonElement>(".memory-model-trigger")!;
    expect(trigger.matches(".qone-select-trigger-compact.settings-value-button")).toBe(true);
    await act(async () => trigger.click());
    const options = [...host.querySelectorAll<HTMLButtonElement>('[role="option"]')];
    expect(options).toHaveLength(3);
    expect(options.slice(1).map(option => option.querySelector("small")!.textContent)).toEqual(["alpha", "beta"]);
    await act(async () => options[2]!.click());
    expect(picked).toEqual(["beta/shared"]);
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    expect(host.querySelector(".memory-model-provider")?.textContent).toBe("beta");
    expect(useStore.getState().selectedModelId).toBe("alpha/shared");
  } finally {
    await act(async () => root.unmount());
    useStore.setState(initial); dom.window.close();
    for (const [key, descriptor] of saved) if (descriptor) Object.defineProperty(globalThis, key, descriptor); else Reflect.deleteProperty(globalThis, key);
  }
});
