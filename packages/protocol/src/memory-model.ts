import type { ModelConfigInfo } from "./index";
import { detectImageModel, isImageApiFormat } from "./image-model";
import { parseModelMetadata } from "./model-metadata";

/** Memory completion sends and receives text; dedicated media routes cannot do it. */
export function supportsMemorySummary({ enabled, model, provider, config }: ModelConfigInfo): boolean {
  if (!enabled) return false;
  const output = config.output;
  if (Array.isArray(output) && (!output.includes("text") || output.includes("audio") || output.includes("video"))) return false;
  return !detectImageModel({
    model, provider, apiType: typeof config.apiType === "string" ? config.apiType : undefined,
    imageApiFormat: isImageApiFormat(config.imageApiFormat) ? config.imageApiFormat : undefined,
    output: Array.isArray(output) ? output.filter((value): value is string => typeof value === "string") : undefined,
    manualOutput: (config.metadataOverrides as { output?: unknown } | undefined)?.output === true,
    metadata: parseModelMetadata(config.modelMetadata, model),
  }).isImageModel;
}
