import { afterEach, expect, test } from "bun:test";
import type { ModelConfigInfo } from "@qone/protocol";
import { ACTIVE_PROVIDER_STORAGE_KEY, PROVIDERS_STORAGE_KEY, filterPickerModels, getPickerModels, readCurrentProvider } from "../src/lib/model-picker-data";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
function seed(profiles: unknown, active = "b") {
  const saved = new Map([[PROVIDERS_STORAGE_KEY, JSON.stringify(profiles)], [ACTIVE_PROVIDER_STORAGE_KEY, active]]);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => saved.get(key) ?? null } } });
  return saved;
}
const a = { id: "a", name: "Provider A", models: [{ id: "shared", label: "A model" }] };
const b = { id: "b", name: "Provider B", models: [{ id: "shared", label: "B model" }] };
function config(provider: string, enabled = true): ModelConfigInfo {
  return { id: `${provider}/shared`, provider, model: "shared", config: {}, enabled, updatedAt: 0 };
}

test("reads the active configuration and isolates models with identical names", () => {
  seed([a, b]);
  expect(getPickerModels(readCurrentProvider(), [config("a"), config("b")])).toEqual([
    { id: "b/shared", modelName: "shared", label: "B model", detail: "Provider B" },
  ]);
});
test("saved models remain selectable before the runtime responds", () => {
  seed([a, b]);
  expect(getPickerModels(readCurrentProvider(), [])[0]?.id).toBe("b/shared");
});
test("empty configuration does not leak other providers or stale runtime models", () => {
  seed([a, { ...b, models: [] }]);
  expect(getPickerModels(readCurrentProvider(), [config("a"), config("b")])).toEqual([]);
});
test("disabled runtime models cannot be selected", () => {
  seed([b]);
  expect(getPickerModels(readCurrentProvider(), [config("b", false)])).toEqual([]);
});
test("provider changes and deletion follow the same first-provider fallback as Settings", () => {
  const saved = seed([a, b]);
  saved.set(ACTIVE_PROVIDER_STORAGE_KEY, "a");
  expect(readCurrentProvider()?.id).toBe("a");
  saved.set(PROVIDERS_STORAGE_KEY, JSON.stringify([b]));
  expect(readCurrentProvider()?.id).toBe("b");
});
test("missing and malformed storage safely produce an empty list", () => {
  const saved = seed({ invalid: true });
  expect(readCurrentProvider()).toBeUndefined();
  saved.set(PROVIDERS_STORAGE_KEY, "bad json");
  expect(getPickerModels(readCurrentProvider(), [config("a")])).toEqual([]);
});

test("filters model labels and raw names without changing the source list", () => {
  seed([{
    id: "b",
    name: "Provider B",
    models: [
      { id: "deepseek-v4", label: "DeepSeek V4 Pro" },
      { id: "grok-4.5", label: "Grok 4.5" },
      { id: "internal-001", label: "Reasoning model" },
    ],
  }]);
  const models = getPickerModels(readCurrentProvider(), []);
  expect(filterPickerModels(models, "deepseek").map((model) => model.modelName)).toEqual(["deepseek-v4"]);
  expect(filterPickerModels(models, "GROK").map((model) => model.label)).toEqual(["Grok 4.5"]);
  expect(filterPickerModels(models, "001").map((model) => model.label)).toEqual(["Reasoning model"]);
  expect(filterPickerModels(models, "   ")).toHaveLength(3);
  expect(models).toHaveLength(3);
});
