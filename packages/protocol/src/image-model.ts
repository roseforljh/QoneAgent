import type { ModelCapability, ModelMetadata } from "./model-metadata";

export type ImageApiFormat = "openai-image" | "gemini-image" | "qwen-image" | "seedream-image";
const IMAGE_API_FORMATS = new Set<ImageApiFormat>(["openai-image", "gemini-image", "qwen-image", "seedream-image"]);

export function isImageApiFormat(value: unknown): value is ImageApiFormat {
  return typeof value === "string" && IMAGE_API_FORMATS.has(value as ImageApiFormat);
}
export type ImageModelDetectionSource = "manual-format" | "manual-capability" | "metadata" | "provider" | "model-name";

export interface ImageModelDetectionInput {
  model: string;
  provider?: string;
  apiType?: string;
  imageApiFormat?: ImageApiFormat;
  input?: ModelCapability[] | string[];
  output?: ModelCapability[] | string[];
  manualInput?: boolean;
  manualOutput?: boolean;
  metadata?: Pick<ModelMetadata, "input" | "output" | "supportedMethods" | "imageApiFormat">;
}

export interface ImageModelDetection {
  isImageModel: boolean;
  format?: ImageApiFormat;
  source?: ImageModelDetectionSource;
}

function lastModelNamePart(value: string): string {
  return value.trim().split(/[/:]/).at(-1) ?? "";
}

function normalized(value: string | undefined): string {
  return (value ?? "").trim().toLowerCase();
}

export function isGptImageModelName(name: string): boolean {
  return /^gpt-image(?:-|$)/i.test(lastModelNamePart(name));
}

export function isGeminiImageModelName(name: string): boolean {
  const value = lastModelNamePart(name);
  return /^(?:gemini-.+image|nano-banana(?:-|$))/i.test(value) || /(?:^|[-_])nano[-_]?banana(?:[-_]|$)/i.test(value);
}

export function isQwenImageModelName(name: string): boolean {
  return /^qwen-image(?:-|$)/i.test(lastModelNamePart(name));
}

export function isSeedreamModelName(name: string): boolean {
  return /^(?:doubao-)?seedream(?:-|$)/i.test(lastModelNamePart(name));
}

export function imageApiFormatForModelName(name: string): ImageApiFormat | undefined {
  if (isGptImageModelName(name)) return "openai-image";
  if (isGeminiImageModelName(name)) return "gemini-image";
  if (isQwenImageModelName(name)) return "qwen-image";
  if (isSeedreamModelName(name)) return "seedream-image";
  return undefined;
}

function formatForProvider(provider: string | undefined, apiType: string | undefined): ImageApiFormat | undefined {
  const providerName = normalized(provider);
  const api = normalized(apiType);
  if (api === "google" || /(?:^|[-_/])(?:google|gemini)(?:$|[-_/])/.test(providerName)) return "gemini-image";
  if (/(?:qwen|dashscope|aliyun|alibaba)/.test(providerName)) return "qwen-image";
  if (/(?:seedream|volcengine|bytedance|doubao|ark)/.test(providerName)) return "seedream-image";
  if (/(?:openai|azure)/.test(providerName)) return "openai-image";
  return undefined;
}

function inferredImageFormat(model: string, provider: string | undefined, apiType: string | undefined): ImageApiFormat | undefined {
  // A known model family is stronger evidence than the provider label. Custom
  // gateways often use generic provider IDs for models from several vendors.
  return imageApiFormatForModelName(model) ?? formatForProvider(provider, apiType);
}

function includesImage(value: ModelCapability[] | string[] | undefined): boolean {
  return value?.some((item) => normalized(item) === "image") ?? false;
}

function includesImageMethod(value: string[] | undefined): boolean {
  return value?.some((item) => /(?:image|images\.(?:generations|edits)|generate[_-]?image)/i.test(item)) ?? false;
}

/** Select the image wire format with explicit configuration taking priority. */
export function detectImageModel(input: ImageModelDetectionInput): ImageModelDetection {
  if (input.manualOutput) {
    if (!includesImage(input.output)) return { isImageModel: false, source: "manual-capability" };
    return { isImageModel: true, format: isImageApiFormat(input.imageApiFormat) ? input.imageApiFormat : inferredImageFormat(input.model, input.provider, input.apiType) ?? "openai-image", source: "manual-capability" };
  }
  if (isImageApiFormat(input.imageApiFormat)) return { isImageModel: true, format: input.imageApiFormat, source: "manual-format" };
  const metadataFormat = isImageApiFormat(input.metadata?.imageApiFormat) ? input.metadata.imageApiFormat : undefined;
  if (input.metadata?.output !== undefined) {
    if (!includesImage(input.metadata.output)) return { isImageModel: false, source: "metadata" };
    return {
      isImageModel: true,
      format: metadataFormat ?? inferredImageFormat(input.model, input.provider, input.apiType) ?? "openai-image",
      source: "metadata",
    };
  }
  if (input.metadata?.supportedMethods !== undefined) {
    if (!includesImageMethod(input.metadata.supportedMethods)) return { isImageModel: false, source: "metadata" };
    return { isImageModel: true, format: metadataFormat ?? inferredImageFormat(input.model, input.provider, input.apiType) ?? "openai-image", source: "metadata" };
  }
  if (metadataFormat) return { isImageModel: true, format: metadataFormat, source: "metadata" };
  if (includesImage(input.output)) return { isImageModel: true, format: inferredImageFormat(input.model, input.provider, input.apiType) ?? "openai-image", source: "manual-capability" };
  const modelFormat = imageApiFormatForModelName(input.model);
  if (modelFormat) return { isImageModel: true, format: modelFormat, source: "model-name" };
  // A provider name alone is not evidence that every model it serves is an
  // image model. Keep ordinary text models on the existing chat path.
  return { isImageModel: false };
}

export function supportsExtendedImageQuality(name: string): boolean {
  return /^gpt-image-2\.5(?:-|$)/i.test(lastModelNamePart(name));
}
