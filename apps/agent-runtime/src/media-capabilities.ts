import type { MessageAttachmentInfo, ModelConfigInfo } from "@qone/protocol";

export type MediaCapability = "text" | "image" | "video" | "audio";
const CAPABILITIES: readonly MediaCapability[] = ["text", "image", "video", "audio"];

export function configuredCapabilities(configs: readonly ModelConfigInfo[], modelKey: string) {
  const config = configs.find((item) => item.enabled && `${item.provider}/${item.model}` === modelKey)?.config;
  const selected = (value: unknown): MediaCapability[] => Array.isArray(value)
    ? CAPABILITIES.filter((capability) => value.includes(capability))
    : ["text"];
  const manualInput = config?.autoMetadata === false || Boolean(config?.metadataOverrides && typeof config.metadataOverrides === "object"
    && (config.metadataOverrides as Record<string, unknown>).input === true);
  return { input: config?.apiType === "google" && !manualInput ? [...CAPABILITIES] : selected(config?.input), output: selected(config?.output) };
}

export function canReadAttachment(input: readonly MediaCapability[], attachment: MessageAttachmentInfo): boolean {
  if (attachment.mimeType.startsWith("video/")) return input.includes("video");
  if (attachment.mimeType.startsWith("audio/")) return input.includes("audio");
  if (attachment.mimeType.startsWith("image/") || attachment.type === "image") return input.includes("image");
  return true;
}

/** Whether the configured API route can actually deliver this medium to the model. */
export function canProcessMediaAttachment(api: string, input: readonly MediaCapability[], attachment: MessageAttachmentInfo): boolean {
  if (attachment.mimeType.startsWith("video/")) {
    return input.includes("video") && (api === "google-generative-ai" || input.includes("image"));
  }
  if (attachment.mimeType.startsWith("audio/")) {
    return input.includes("audio") && (api === "google-generative-ai" || api === "openai-completions");
  }
  return canReadAttachment(input, attachment);
}
