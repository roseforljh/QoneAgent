import { detectImageModel, type ImageApiFormat, type ModelConfigInfo, type ModelMetadata, type ProviderApiType } from "@qone/protocol";
import { defaultModelSettings, withProviderInputDefaults, type ModelSettings, type ProviderModel, type ProviderProfile } from "./model-settings";

export const PROVIDERS_STORAGE_KEY = "qone-model-providers";
export const ACTIVE_PROVIDER_STORAGE_KEY = "qone-active-provider";
export const MODEL_CONFIG_CHANGE_EVENT = "qone-model-config-change";

export type PickerProvider = { id: string; name: string; models: { id: string; label: string }[] };
export type PickerModel = { id: string; modelName: string; label: string; detail: string };

const providerApiTypes = new Set<ProviderApiType>(["openai-compatible", "codex", "claude", "google"]);

/** Rebuild a profile from the durable runtime records when origin storage is empty. */
export function providerProfilesFromModelConfigs(configs: ModelConfigInfo[]): ProviderProfile[] {
  const grouped = new Map<string, { models: ProviderModel[]; apiType: ProviderApiType; baseUrl: string; updatedAt: number }>();
  for (const config of configs) {
    if (!config.enabled) continue;
    const saved = config.config ?? {};
    const current = grouped.get(config.provider) ?? {
      models: [],
      apiType: providerApiTypes.has(saved.apiType as ProviderApiType) ? saved.apiType as ProviderApiType : "openai-compatible",
      baseUrl: typeof saved.baseUrl === "string" ? saved.baseUrl : "",
      updatedAt: config.updatedAt,
    };
    const detectedImage = detectImageModel({
      model: config.model,
      provider: config.provider,
      apiType: typeof saved.apiType === "string" ? saved.apiType : undefined,
      imageApiFormat: typeof saved.imageApiFormat === "string" ? saved.imageApiFormat as ImageApiFormat : undefined,
      input: Array.isArray(saved.input) ? saved.input as string[] : undefined,
      output: Array.isArray(saved.output) ? saved.output as string[] : undefined,
      manualInput: recordBoolean(saved.metadataOverrides, "input"),
      manualOutput: recordBoolean(saved.metadataOverrides, "output"),
      metadata: saved.modelMetadata && typeof saved.modelMetadata === "object" ? saved.modelMetadata as ModelMetadata : undefined,
    });
    const manualInput = recordBoolean(saved.metadataOverrides, "input");
    const manualOutput = recordBoolean(saved.metadataOverrides, "output");
    const settings = withProviderInputDefaults({
      ...defaultModelSettings(current.apiType),
      ...saved,
      ...(detectedImage.isImageModel ? {
        ...(manualInput ? {} : { input: ["text", "image"] }),
        ...(manualOutput ? {} : { output: ["image"] }),
      } : {}),
      apiType: providerApiTypes.has(saved.apiType as ProviderApiType) ? saved.apiType as ProviderApiType : current.apiType,
    } as ModelSettings, providerApiTypes.has(saved.apiType as ProviderApiType) ? saved.apiType as ProviderApiType : current.apiType);
    current.models.push({
      id: config.model,
      label: typeof saved.displayName === "string" && saved.displayName ? saved.displayName : config.model,
      settings,
    });
    current.updatedAt = Math.max(current.updatedAt, config.updatedAt);
    if (!current.baseUrl && typeof saved.baseUrl === "string") current.baseUrl = saved.baseUrl;
    grouped.set(config.provider, current);
  }
  return [...grouped.entries()].map(([id, value]) => ({
    id,
    name: id,
    apiType: value.apiType,
    baseUrl: value.baseUrl,
    models: value.models,
    updatedAt: value.updatedAt,
  }));
}

function recordBoolean(value: unknown, key: string): boolean {
  return Boolean(value && typeof value === "object" && !Array.isArray(value) && (value as Record<string, unknown>)[key] === true);
}

export function filterPickerModels(models: PickerModel[], query: string): PickerModel[] {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized) return models;
  return models.filter((model) =>
    [model.label, model.modelName].some((value) => value.toLocaleLowerCase().includes(normalized)),
  );
}

export function readCurrentProvider(): PickerProvider | undefined {
  try {
    const saved: unknown = JSON.parse(window.localStorage.getItem(PROVIDERS_STORAGE_KEY) ?? "[]");
    if (!Array.isArray(saved)) return;
    const profiles = saved.filter((value): value is PickerProvider => value && typeof value.id === "string" && typeof value.name === "string");
    const activeId = window.localStorage.getItem(ACTIVE_PROVIDER_STORAGE_KEY);
    const provider = profiles.find((item) => item.id === activeId) ?? profiles[0];
    if (!provider) return;
    const models = Array.isArray(provider.models) ? provider.models.filter((model) => model && typeof model.id === "string") : [];
    return { ...provider, models: models.map((model) => ({ id: model.id, label: typeof model.label === "string" ? model.label : model.id })) };
  } catch { return; }
}

/** Recreate origin-scoped picker data from the durable runtime model records. */
export function restoreProviderProfilesFromModelConfigs(configs: ModelConfigInfo[]): PickerProvider | undefined {
  const current = readCurrentProvider();
  if (current) return current;
  const profiles = providerProfilesFromModelConfigs(configs);
  const first = profiles[0];
  if (!first) return undefined;
  try {
    window.localStorage.setItem(PROVIDERS_STORAGE_KEY, JSON.stringify(profiles));
    window.localStorage.setItem(ACTIVE_PROVIDER_STORAGE_KEY, first.id);
    window.dispatchEvent(new Event(MODEL_CONFIG_CHANGE_EVENT));
  } catch { /* Restricted previews may not expose persistent storage. */ }
  return { id: first.id, name: first.name, models: first.models.map((model) => ({ id: model.id, label: model.label })) };
}

export function getPickerModels(provider: PickerProvider | undefined, configs: ModelConfigInfo[]): PickerModel[] {
  // The saved profile is authoritative, including an intentionally empty list.
  // Never fall back to another provider when the current one has no models.
  if (!provider) return [];
  const currentConfigs = new Map(configs.filter((config) => config.provider === provider.id).map((config) => [config.model, config]));
  return provider.models.flatMap((model) => {
    const config = currentConfigs.get(model.id);
    if (config && !config.enabled) return [];
    return [{ id: config?.id ?? `${provider.id}/${model.id}`, modelName: model.id, label: model.label || model.id, detail: provider.name }];
  });
}
