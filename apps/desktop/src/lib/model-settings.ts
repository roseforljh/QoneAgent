import { normalizeThinkingLevelForApi, parseModelMetadataResponse, thinkingLevelsForApi as protocolThinkingLevelsForApi, type ModelMetadata, type ModelMetadataSource, type ModelMetadataSources, type ProviderApiType, type RunThinkingLevel } from "@qone/protocol";

export type Capability = "text" | "image" | "video" | "audio";
export type ThinkingLevel = RunThinkingLevel;
export const thinkingLevelOptions = [
  { value: "none", labelKey: "model.noThinking" },
  { value: "minimal", labelKey: "model.minimal" },
  { value: "low", labelKey: "model.low" },
  { value: "medium", labelKey: "model.medium" },
  { value: "high", labelKey: "model.high" },
  { value: "xhigh", labelKey: "model.xhigh" },
  { value: "max", labelKey: "model.max" },
] as const;
export type ModelSettingField = "maxOutput" | "maxContext" | "thinking" | "input" | "output";

export type ModelSettings = {
  apiType?: ProviderApiType;
  maxOutput: number;
  maxContext: number;
  thinking: ThinkingLevel;
  input: Capability[];
  output: Capability[];
  autoMetadata?: boolean;
  modelMetadata?: ModelMetadata;
  metadataSources?: Partial<Record<ModelSettingField, ModelMetadataSource>>;
  metadataOverrides?: Partial<Record<"maxOutput" | "maxContext" | "thinking" | "input" | "output", boolean>>;
};

export type ProviderModel = { id: string; label: string; settings?: ModelSettings };
export type ProviderProfile = { id: string; name: string; apiType: ProviderApiType; baseUrl: string; models: ProviderModel[]; updatedAt: number };

export const capabilities: Capability[] = ["text", "image", "video", "audio"];
export function thinkingLevelsForApi(apiType: ProviderApiType = "openai-compatible"): ThinkingLevel[] {
  return [...protocolThinkingLevelsForApi(apiType)];
}

export function thinkingLevelOptionsForApi(apiType?: ProviderApiType) {
  const allowed = new Set(thinkingLevelsForApi(apiType));
  return thinkingLevelOptions.filter((option) => allowed.has(option.value));
}

export function normalizeThinkingLevel(value: unknown, apiType?: ProviderApiType): ThinkingLevel {
  return normalizeThinkingLevelForApi(value, apiType);
}

export function defaultModelSettings(): ModelSettings {
  return { maxOutput: 8192, maxContext: 128000, thinking: "none", input: ["text"], output: ["text"], autoMetadata: true, metadataSources: { maxOutput: "default", maxContext: "default", thinking: "default", input: "default", output: "default" } };
}

export function modelSettingsFromMetadata(metadata?: ModelMetadata, sources?: ModelMetadataSources): ModelSettings {
  const defaults = defaultModelSettings();
  if (!metadata) return defaults;
  const input = metadata.input?.filter((value): value is Capability => capabilities.includes(value as Capability));
  const output = metadata.output?.filter((value): value is Capability => capabilities.includes(value as Capability));
  return {
    ...defaults,
    ...(metadata.maxTokens ? { maxOutput: metadata.maxTokens } : {}),
    ...(metadata.contextWindow ? { maxContext: metadata.contextWindow } : {}),
    ...(input?.length ? { input } : {}),
    ...(output?.length ? { output } : {}),
    modelMetadata: metadata,
    metadataSources: {
      maxOutput: sources?.maxTokens ?? (metadata.maxTokens ? "provider" : "default"),
      maxContext: sources?.contextWindow ?? (metadata.contextWindow ? "provider" : "default"),
      thinking: "default",
      input: sources?.input ?? (metadata.input?.length ? "provider" : "default"),
      output: sources?.output ?? (metadata.output?.length ? "provider" : "default"),
    },
  };
}

export function parseModelsResponse(data: unknown): ProviderModel[] {
  return parseModelMetadataResponse(data).map((item) => ({
    id: item.id,
    label: item.label,
    settings: modelSettingsFromMetadata(item.metadata),
  }));
}

export function withResolvedModelSettings(model: ProviderModel, metadata: ModelMetadata, sources: ModelMetadataSources): ProviderModel {
  return { ...model, settings: { ...modelSettingsFromMetadata(metadata, sources), ...(model.settings?.apiType ? { apiType: model.settings.apiType } : {}), modelMetadata: model.settings?.modelMetadata } };
}

function sameValue<T>(left: T, right: T): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((value, index) => value === right[index]);
  return left === right;
}

function refreshedValue<T>(current: T, incoming: T | undefined, cached: T | undefined, fallback: T, manual?: boolean): T {
  if (manual) return current;
  if (incoming !== undefined) return incoming;
  return cached !== undefined && sameValue(current, cached) ? fallback : current;
}

export function mergeFetchedModel(existing: ProviderModel, fetched: ProviderModel): ProviderModel {
  const current = existing.settings ?? defaultModelSettings();
  const incoming = fetched.settings ?? defaultModelSettings();
  const defaults = defaultModelSettings();
  const overrides = current.metadataOverrides ?? {};
  const metadata = incoming.modelMetadata;
  const cached = current.modelMetadata;
  const cachedSettings = cached ? modelSettingsFromMetadata(cached) : undefined;
  const hasFetched = (field: ModelSettingField) => incoming.metadataSources?.[field] !== undefined && incoming.metadataSources[field] !== "default";
  return {
    ...existing,
    label: fetched.label || existing.label,
    settings: {
      ...current,
      maxOutput: refreshedValue(current.maxOutput, hasFetched("maxOutput") ? incoming.maxOutput : undefined, cached?.maxTokens, defaults.maxOutput, overrides.maxOutput),
      maxContext: refreshedValue(current.maxContext, hasFetched("maxContext") ? incoming.maxContext : undefined, cached?.contextWindow, defaults.maxContext, overrides.maxContext),
      thinking: current.apiType || incoming.apiType ? normalizeThinkingLevel(current.thinking, current.apiType ?? incoming.apiType) : current.thinking,
      input: refreshedValue(current.input, hasFetched("input") ? incoming.input : undefined, cached?.input?.length ? cachedSettings?.input : undefined, defaults.input, overrides.input),
      output: refreshedValue(current.output, hasFetched("output") ? incoming.output : undefined, cached?.output?.length ? cachedSettings?.output : undefined, defaults.output, overrides.output),
      modelMetadata: metadata,
      metadataSources: incoming.metadataSources,
      autoMetadata: true,
    },
  };
}
