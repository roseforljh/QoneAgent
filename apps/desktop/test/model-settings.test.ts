import { expect, test } from "bun:test";
import { defaultModelSettings, mergeFetchedModel, modelSettingsFromMetadata, normalizeThinkingLevel, parseModelsResponse, thinkingLevelOptionsForApi, withResolvedModelSettings } from "../src/lib/model-settings";

test("provider model list metadata becomes saved model settings", () => {
  const [listed] = parseModelsResponse({ data: [{ id: "gemini-demo", context_length: 64_000, modalities: { input: ["text", "image"], output: ["text"] } }] });
  expect(listed.settings?.maxContext).toBe(64_000);
  const saved = mergeFetchedModel({ id: listed.id, label: listed.label, settings: defaultModelSettings() }, listed);
  expect(saved.settings).toMatchObject({ maxContext: 64_000, maxOutput: 8192, thinking: "none", input: ["text", "image"], output: ["text"] });
  expect(saved.settings?.modelMetadata).toMatchObject({ contextWindow: 64_000, input: ["text", "image"] });
  expect(saved.settings?.metadataSources).toMatchObject({ maxContext: "provider", maxOutput: "default", input: "provider" });
});

test("refresh keeps explicit user settings while retaining the enriched metadata", () => {
  const existing = { id: "custom", label: "custom", settings: { ...defaultModelSettings(), maxContext: 32_000, output: ["audio" as const], metadataOverrides: { maxContext: true, output: true } } };
  const metadata = { contextWindow: 128_000, maxTokens: 8_000, output: ["text"] };
  const fetched = { id: "custom", label: "Custom", settings: modelSettingsFromMetadata(metadata) };
  const merged = mergeFetchedModel(existing, fetched);
  expect(merged.settings).toMatchObject({ maxContext: 32_000, maxOutput: 8_000, output: ["audio"], modelMetadata: metadata });
});

test("unknown models do not claim unverified media capabilities", () => {
  expect(defaultModelSettings()).toMatchObject({ thinking: "none", input: ["text"], output: ["text"] });
  expect(modelSettingsFromMetadata({ reasoning: true }).thinking).toBe("none");
  expect(modelSettingsFromMetadata({ reasoning: false }).thinking).toBe("none");
});

test("id-only provider responses clear previously inferred metadata without losing manual overrides", () => {
  const old = { id: "gemini-demo", label: "gemini-demo", settings: { ...modelSettingsFromMetadata({ contextWindow: 1_000_000, maxTokens: 65_536, reasoning: true, input: ["text", "image"] }), maxOutput: 4_000, metadataOverrides: { maxOutput: true } } };
  const [provider] = parseModelsResponse({ data: [{ id: "gemini-demo" }] });
  const refreshed = mergeFetchedModel(old, provider);
  expect(refreshed.settings).toMatchObject({ maxContext: 128_000, maxOutput: 4_000, thinking: "none", input: ["text"], output: ["text"] });
  expect(refreshed.settings?.modelMetadata).toBeUndefined();
  expect(refreshed.settings?.metadataSources?.maxContext).toBe("default");
});

test("partial provider metadata does not retain unverified old fields", () => {
  const old = { id: "demo", label: "demo", settings: modelSettingsFromMetadata({ contextWindow: 96_000, maxTokens: 12_000, reasoning: true }) };
  const [provider] = parseModelsResponse({ data: [{ id: "demo", context_length: 48_000 }] });
  const refreshed = mergeFetchedModel(old, provider);
  expect(refreshed.settings).toMatchObject({ maxContext: 48_000, maxOutput: 8192, thinking: "none" });
  expect(refreshed.settings?.modelMetadata?.maxTokens).toBeUndefined();
});

test("unmarked legacy manual values survive a provider response without metadata", () => {
  const old = { id: "legacy", label: "legacy", settings: { ...modelSettingsFromMetadata({ contextWindow: 96_000 }), maxContext: 32_000 } };
  const [provider] = parseModelsResponse({ data: [{ id: "legacy" }] });
  expect(mergeFetchedModel(old, provider).settings?.maxContext).toBe(32_000);
});

test("resolved model settings retain each field's fallback source", () => {
  const sources = { contextWindow: "provider", maxTokens: "pi", reasoning: "models.dev", input: "pi", output: "default" } as const;
  const [listed] = parseModelsResponse({ data: [{ id: "demo", context_length: 64_000 }] });
  const fetched = withResolvedModelSettings(listed, { contextWindow: 64_000, maxTokens: 4_096, reasoning: true, input: ["text", "image"] }, sources);
  const merged = mergeFetchedModel({ id: "demo", label: "demo", settings: defaultModelSettings() }, fetched);
  expect(merged.settings?.metadataSources).toEqual({ maxContext: "provider", maxOutput: "pi", thinking: "default", input: "pi", output: "default" });
  expect(merged.settings).toMatchObject({ maxContext: 64_000, maxOutput: 4_096, thinking: "none", input: ["text", "image"] });
  expect(merged.settings?.modelMetadata).toEqual({ id: "demo", contextWindow: 64_000 });
});

test("model API format controls the available thinking levels", () => {
  expect(thinkingLevelOptionsForApi("openai-compatible").map((item) => item.value)).toEqual(["none", "low", "medium", "high"]);
  expect(thinkingLevelOptionsForApi("codex").map((item) => item.value)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh", "max"]);
  expect(thinkingLevelOptionsForApi("claude").map((item) => item.value)).toEqual(["none", "low", "medium", "high", "max"]);
  expect(thinkingLevelOptionsForApi("google").map((item) => item.value)).toEqual(["none", "minimal", "low", "medium", "high"]);
  expect(normalizeThinkingLevel("minimal", "claude")).toBe("low");
  expect(normalizeThinkingLevel("max", "google")).toBe("high");
  expect(normalizeThinkingLevel("xhigh", "codex")).toBe("xhigh");
});

test("model metadata does not narrow API thinking options", () => {
  const sources = { contextWindow: "pi", maxTokens: "pi", reasoning: "pi", input: "pi", output: "pi" } as const;
  const fetched = withResolvedModelSettings({ id: "gemini-3.1-pro-preview", label: "Gemini" }, { reasoning: false, reasoningOptions: [{ type: "effort", values: ["low"] }] }, sources);
  const saved = mergeFetchedModel({ id: fetched.id, label: fetched.label, settings: { ...defaultModelSettings(), apiType: "google", thinking: "none", metadataOverrides: { thinking: true } } }, fetched);
  expect(saved.settings?.thinking).toBe("none");
  expect(thinkingLevelOptionsForApi(saved.settings?.apiType).map((item) => item.value)).toEqual(["none", "minimal", "low", "medium", "high"]);
  expect(normalizeThinkingLevel("max", "google")).toBe("high");
});
