import { PROVIDERS_STORAGE_KEY, MODEL_CONFIG_CHANGE_EVENT } from "../../lib/model-picker-data";
import { requestModelMetadata } from "../../store";
import { modelBaseUrl, modelListUrl, type ProviderApiType } from "@qone/protocol";
import { modelApiTypeForProvider, withResolvedModelSettings, type ProviderModel, type ProviderProfile } from "../../lib/model-settings";

export const providerApiLabelKeys = {
  "openai-compatible": "provider.openaiCompatible",
  codex: "provider.codex",
  claude: "provider.claude",
  google: "provider.google",
  "google-vertex": "provider.vertexAi",
} as const;

export function loadProviderProfiles(): ProviderProfile[] {
  try {
    const saved = JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE_KEY) ?? "[]") as ProviderProfile[];
    return Array.isArray(saved) ? saved.filter((item) => item && typeof item.id === "string" && typeof item.name === "string") : [];
  } catch {
    return [];
  }
}

export function saveProviderProfiles(profiles: ProviderProfile[]) {
  window.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(profiles));
  window.dispatchEvent(new Event(MODEL_CONFIG_CHANGE_EVENT));
}

export function providerId(name: string) {
  return name.trim().toLowerCase().replace(/[^a-z0-9一-鿿]+/g, "-").replace(/^-|-$/g, "") || `provider-${Date.now()}`;
}

export function normalizeBaseUrl(value: string) {
  return value.trim().replace(/\/+$/, "");
}

export function providerEndpointPreview(apiType: ProviderApiType, baseUrl: string) {
  try { return apiType === "google-vertex" ? modelBaseUrl(apiType, baseUrl) : modelListUrl(apiType, baseUrl); } catch { return ""; }
}

export async function resolveModelSettings(provider: ProviderProfile, models: ProviderModel[]): Promise<ProviderModel[]> {
  if (!models.length) return models;
  const resolved = [] as Awaited<ReturnType<typeof requestModelMetadata>>;
  const byApiType = new Map<ProviderApiType, ProviderModel[]>();
  for (const model of models) {
    const apiType = modelApiTypeForProvider(provider, model.settings);
    byApiType.set(apiType, [...(byApiType.get(apiType) ?? []), model]);
  }
  for (const [apiType, apiModels] of byApiType) {
    for (let start = 0; start < apiModels.length; start += 200) {
      resolved.push(...await requestModelMetadata({ provider: provider.id, apiType, baseUrl: provider.baseUrl, models: apiModels.slice(start, start + 200).map((model) => ({ id: model.id, metadata: model.settings?.modelMetadata })) }));
    }
  }
  const byId = new Map(resolved.map((item) => [item.id, item]));
  return models.map((model) => {
    const item = byId.get(model.id);
    return item ? withResolvedModelSettings(model, item.metadata, item.sources) : model;
  });
}