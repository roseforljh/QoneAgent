import { detectImageModel, type ImageApiFormat, type ModelConfigInfo, type ModelMetadata, type ProviderApiType } from "@qone/protocol";

export function isImageModel(config: ModelConfigInfo | undefined): boolean {
  if (!config) return false;
  const settings = config.config ?? {};
  return detectImageModel({
    model: config.model,
    provider: config.provider,
    apiType: typeof settings.apiType === "string" ? settings.apiType as ProviderApiType : undefined,
    imageApiFormat: typeof settings.imageApiFormat === "string" ? settings.imageApiFormat as ImageApiFormat : undefined,
    input: Array.isArray(settings.input) ? settings.input as string[] : undefined,
    output: Array.isArray(settings.output) ? settings.output as string[] : undefined,
    manualInput: Boolean(settings.metadataOverrides && typeof settings.metadataOverrides === "object" && (settings.metadataOverrides as Record<string, unknown>).input === true),
    manualOutput: Boolean(settings.metadataOverrides && typeof settings.metadataOverrides === "object" && (settings.metadataOverrides as Record<string, unknown>).output === true),
    metadata: settings.modelMetadata && typeof settings.modelMetadata === "object" ? settings.modelMetadata as ModelMetadata : undefined,
  }).isImageModel;
}
