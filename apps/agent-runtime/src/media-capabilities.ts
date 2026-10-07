import type { MessageAttachmentInfo, ModelConfigInfo } from "@qone/protocol";

export type MediaCapability = "text" | "image" | "video" | "audio";
const CAPABILITIES: readonly MediaCapability[] = ["text", "image", "video", "audio"];

export interface ModelMediaCapabilities {
  input: MediaCapability[];
  output: MediaCapability[];
  inputConfirmed: boolean;
  outputConfirmed: boolean;
  video: {
    native: boolean;
    frames: boolean;
    preferred: "native" | "frames" | "none";
  };
  audio: {
    native: boolean;
    extract: boolean;
  };
}

export function configuredCapabilities(configs: readonly ModelConfigInfo[], modelKey: string) {
  const config = configs.find((item) => item.enabled && `${item.provider}/${item.model}` === modelKey)?.config;
  const selected = (value: unknown): { value: MediaCapability[]; confirmed: boolean } => Array.isArray(value)
    ? { value: CAPABILITIES.filter((capability) => value.includes(capability)), confirmed: true }
    : { value: ["text"], confirmed: false };
  const input = selected(config?.input);
  const output = selected(config?.output);
  return {
    input: input.value,
    output: output.value,
    inputConfirmed: input.confirmed,
    outputConfirmed: output.confirmed,
    video: {
      native: input.value.includes("video"),
      frames: input.value.includes("image"),
      preferred: input.value.includes("video") ? "native" : input.value.includes("image") ? "frames" : "none",
    },
    audio: { native: input.value.includes("audio"), extract: input.value.includes("audio") },
  } satisfies ModelMediaCapabilities;
}

export function mediaCapabilitiesContext(capabilities: ModelMediaCapabilities): string {
  const attribute = (value: string | boolean) => String(value).replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  return `<qone-model-capabilities input="${attribute(capabilities.input.join(","))}" output="${attribute(capabilities.output.join(","))}" input-confirmed="${attribute(capabilities.inputConfirmed)}" output-confirmed="${attribute(capabilities.outputConfirmed)}" video-native="${attribute(capabilities.video.native)}" video-frames="${attribute(capabilities.video.frames)}" video-preferred="${attribute(capabilities.video.preferred)}" audio-native="${attribute(capabilities.audio.native)}" audio-extract="${attribute(capabilities.audio.extract)}" />`;
}

export function canReadAttachment(input: readonly MediaCapability[], attachment: MessageAttachmentInfo): boolean {
  if (attachment.mimeType.startsWith("video/")) return input.includes("video");
  if (attachment.mimeType.startsWith("audio/")) return input.includes("audio");
  if (attachment.mimeType.startsWith("image/") || attachment.type === "image") return input.includes("image");
  return true;
}

/** Whether the configured API route can actually deliver this medium to the model. */
export function canProcessMediaAttachment(_api: string, input: readonly MediaCapability[], attachment: MessageAttachmentInfo): boolean {
  if (attachment.mimeType.startsWith("video/")) {
    return input.includes("video") || input.includes("image");
  }
  if (attachment.mimeType.startsWith("audio/")) {
    return input.includes("audio");
  }
  return canReadAttachment(input, attachment);
}
