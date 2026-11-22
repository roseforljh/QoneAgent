import { afterEach, expect, test } from "bun:test";
import { vertexProjectBaseUrl, vertexProjectFromBaseUrl, type ModelConfigInfo } from "@qone/protocol";
import { defaultModelSettings, modelConfigForProvider, saveVertexModel, type ProviderProfile } from "../src/lib/model-settings";
import { saveModelConfig, settleModelConfigSave } from "../src/lib/model-config-save";
import { ACTIVE_PROVIDER_STORAGE_KEY, PROVIDERS_STORAGE_KEY, filterPickerModels, getPickerModels, providerProfilesFromModelConfigs, readCurrentProvider, restoreProviderProfilesFromModelConfigs } from "../src/lib/model-picker-data";

const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
afterEach(() => {
  if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
  else Reflect.deleteProperty(globalThis, "window");
});
function seed(profiles: unknown, active = "b") {
  const saved = new Map([[PROVIDERS_STORAGE_KEY, JSON.stringify(profiles)], [ACTIVE_PROVIDER_STORAGE_KEY, active]]);
  Object.defineProperty(globalThis, "window", { configurable: true, value: { localStorage: { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value) }, dispatchEvent: () => true, Event } });
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

test("recovers a provider profile from durable runtime model configs", () => {
  expect(providerProfilesFromModelConfigs([
    { id: "acme/alpha", provider: "acme", model: "alpha", config: { apiType: "claude", baseUrl: "https://api.example.com", maxOutput: 4096 }, enabled: true, updatedAt: 20 },
    { id: "acme/beta", provider: "acme", model: "beta", config: { apiType: "claude", baseUrl: "https://api.example.com" }, enabled: true, updatedAt: 30 },
    { id: "disabled/model", provider: "disabled", model: "model", config: {}, enabled: false, updatedAt: 40 },
  ])).toMatchObject([{
    id: "acme",
    name: "acme",
    apiType: "claude",
    baseUrl: "https://api.example.com",
    models: [
      { id: "alpha", settings: { maxOutput: 4096, apiType: "claude" } },
      { id: "beta", settings: { apiType: "claude" } },
    ],
  }]);
});

test("restores a Vertex AI provider and model from runtime settings", () => {
  const baseUrl = "https://aiplatform.googleapis.com/v1/projects/demo/locations/global";
  const profiles = providerProfilesFromModelConfigs([
    { ...config("vertex"), config: { apiType: "google-vertex", baseUrl } },
  ]);
  expect(profiles).toMatchObject([{ id: "vertex", apiType: "google-vertex", baseUrl, models: [{ settings: { apiType: "google-vertex" } }] }]);
});

test("does not leave provider endpoint fields in restored model settings", () => {
  const [profile] = providerProfilesFromModelConfigs([{ ...config("vertex"), config: {
    apiType: "google-vertex", baseUrl: "https://us-central1-aiplatform.googleapis.com/v1/projects/demo-project/locations/us-central1",
    displayName: "Gemini", maxOutput: 4096,
  } }]);
  expect(profile!.models[0]!.settings).not.toHaveProperty("baseUrl");
  expect(profile!.models[0]).toMatchObject({ label: "Gemini", settings: { maxOutput: 4096 } });
});

test("restores the provider format independently of a model API override", () => {
  const baseUrl = "https://gateway.example.test/v1";
  const [profile] = providerProfilesFromModelConfigs([{ ...config("gateway"), config: {
    providerApiType: "codex", apiType: "openai-compatible", baseUrl,
  } }]);
  expect(profile).toMatchObject({ apiType: "codex", baseUrl, models: [{ settings: { apiType: "openai-compatible" } }] });
});

test("saving a Vertex edit replaces stale Google endpoints on every model and round-trips the edited model ID", () => {
  const oldUrl = "https://generativelanguage.googleapis.com/v1beta";
  const stale = { ...defaultModelSettings("google"), baseUrl: oldUrl, apiType: "google" as const };
  const baseUrl = vertexProjectBaseUrl("demo-project", "us-central1");
  const models = [{ id: "old-model", label: "Old", settings: stale }, { id: "second-model", label: "Second", settings: stale }];
  expect(saveVertexModel(models, "old-model", "second-model")).toBeUndefined();
  const edited = saveVertexModel(models, "old-model", "gemini-test")!;
  const profile: ProviderProfile = { id: "vertex", name: "Vertex", apiType: "google-vertex", baseUrl, models: edited, updatedAt: 1 };
  const configs = edited.map((model) => modelConfigForProvider(profile, model));
  for (const item of configs) expect(item.config).toMatchObject({ providerApiType: "google-vertex", apiType: "google-vertex", baseUrl });
  const [restored] = providerProfilesFromModelConfigs(configs);
  expect(vertexProjectFromBaseUrl(restored!.baseUrl)).toEqual({ projectId: "demo-project", location: "us-central1" });
  expect(restored!.models.map((item) => item.id)).toEqual(["gemini-test", "second-model"]);
  expect(saveVertexModel(edited, "", "another-model")?.map((item) => item.id)).toEqual(["gemini-test", "second-model", "another-model"]);
});

test("model saves wait for the runtime and surface a rejected write", async () => {
  const value = config("vertex");
  const save = saveModelConfig({ type: "model.upsert", requestId: "first", config: value }, async () => true);
  let confirmed = false;
  void save.then(() => { confirmed = true; });
  expect(settleModelConfigSave({ type: "model.updated", requestId: "unrelated", config: value })).toBe(false);
  await Promise.resolve();
  expect(confirmed).toBe(false);
  expect(settleModelConfigSave({ type: "model.updated", requestId: "first", config: value })).toBe(true);
  await save;
  expect(confirmed).toBe(true);

  const failed = saveModelConfig({ type: "model.upsert", requestId: "second", config: value }, async () => true);
  settleModelConfigSave({ type: "error", requestId: "second", message: "write failed" });
  await expect(failed).rejects.toThrow("write failed");
});

test("runtime file edits replace cached models without losing provider names or selection", () => {
  seed([{ ...b, apiType: "openai-compatible", baseUrl: "https://old.dev" }]);
  restoreProviderProfilesFromModelConfigs([{ ...config("b"), model: "new", id: "b/new", config: { baseUrl: "https://new.dev", displayName: "New label" } }]);
  expect(readCurrentProvider()).toEqual({ id: "b", name: "Provider B", apiType: "openai-compatible", baseUrl: "https://new.dev", models: [{ id: "new", label: "New label" }], updatedAt: 0 });
  restoreProviderProfilesFromModelConfigs([]);
  expect(readCurrentProvider()?.models).toEqual([]);
  restoreProviderProfilesFromModelConfigs([config("added")]);
  expect(readCurrentProvider()?.id).toBe("b");
  expect(JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE_KEY)!).some((profile: { id: string }) => profile.id === "added")).toBe(true);
});

test("durable runtime models remain available without picker storage", () => {
  const configs = [config("acme")];
  const recovered = providerProfilesFromModelConfigs(configs)[0];
  expect(getPickerModels(recovered, configs)).toEqual([
    { id: "acme/shared", modelName: "shared", label: "shared", detail: "acme" },
  ]);
});
