import type { MessageAttachmentInfo, ModelConfigInfo } from "@qone/protocol";
import { detectImageModel, type ImageApiFormat, type ModelMetadata } from "@qone/protocol";
import { generateImage } from "./image-generation.js";
import { generateSpeech } from "./speech-generation.js";
import { generateVideo } from "./video-generation.js";
import { runtimeError, runtimeText } from "./runtime-localization";

/** Storage hook the adapter supplies; media bytes go to the artifact store. */
export type GeneratedMediaSink = (
  sessionId: string, runId: string, data: Uint8Array | ReadableStream<Uint8Array>,
  mimeType: string, extension: string, signal: AbortSignal,
) => Promise<string>;

export interface GenerationContext {
  apiKeyFor(provider: string): string | undefined;
  push(type: string, payload: unknown, sessionId: string, runId: string): void;
  onGeneratedMedia?: GeneratedMediaSink;
  /** Tracks the per-run controller so `stop(runId)` can abort generation. */
  trackController(runId: string, controller: AbortController): void;
  releaseController(runId: string): void;
}

export async function runImageGeneration(
  ctx: GenerationContext, sessionId: string, runId: string,
  prompt: string, attachments: MessageAttachmentInfo[] | undefined, config: ModelConfigInfo,
): Promise<void> {
  const rawConfig = config.config && typeof config.config === "object" ? config.config : {};
  const detected = detectImageModel({
    model: config.model,
    provider: config.provider,
    apiType: typeof rawConfig.apiType === "string" ? rawConfig.apiType : undefined,
    imageApiFormat: typeof rawConfig.imageApiFormat === "string" ? rawConfig.imageApiFormat as ImageApiFormat : undefined,
    input: Array.isArray(rawConfig.input) ? rawConfig.input as string[] : undefined,
    output: Array.isArray(rawConfig.output) ? rawConfig.output as string[] : undefined,
    manualInput: Boolean(rawConfig.metadataOverrides && typeof rawConfig.metadataOverrides === "object" && (rawConfig.metadataOverrides as Record<string, unknown>).input === true),
    manualOutput: Boolean(rawConfig.metadataOverrides && typeof rawConfig.metadataOverrides === "object" && (rawConfig.metadataOverrides as Record<string, unknown>).output === true),
    metadata: rawConfig.modelMetadata && typeof rawConfig.modelMetadata === "object" ? rawConfig.modelMetadata as ModelMetadata : undefined,
  });
  if (!detected.isImageModel || !detected.format) throw new Error("Image model format could not be determined");
  const apiKey = ctx.apiKeyFor(config.provider);
  if (!apiKey) throw new Error(`No API key configured for image provider ${config.provider}`);
  const controller = new AbortController();
  ctx.trackController(runId, controller);
  ctx.push("message.started", { message: { role: "assistant" } }, sessionId, runId);
  try {
    const parts = await generateImage({ config, format: detected.format, prompt, attachments, apiKey, signal: controller.signal });
    ctx.push("message.completed", { message: { role: "assistant", content: parts } }, sessionId, runId);
  } finally {
    ctx.releaseController(runId);
  }
}

export async function runSpeechGeneration(
  ctx: GenerationContext, sessionId: string, runId: string, text: string, config: ModelConfigInfo,
): Promise<void> {
  const apiKey = ctx.apiKeyFor(config.provider);
  if (!apiKey) throw runtimeError("pi-adapter.no_api_key_configured_for_speech_provider", { p0: config.provider });
  if (!ctx.onGeneratedMedia) throw runtimeError("pi-adapter.speech_result_storage_is_not_initialized", {});
  const controller = new AbortController();
  ctx.trackController(runId, controller);
  ctx.push("message.started", { message: { role: "assistant" } }, sessionId, runId);
  try {
    const speech = await generateSpeech({ config, text, apiKey, signal: controller.signal });
    controller.signal.throwIfAborted();
    const savedPath = await ctx.onGeneratedMedia(sessionId, runId, speech.bytes, speech.mimeType, speech.extension, controller.signal);
    controller.signal.throwIfAborted();
    ctx.push("message.completed", { message: { role: "assistant", content: [{ type: "text", text: runtimeText("pi-adapter.speech_generated", { p0: savedPath }) }] } }, sessionId, runId);
  } finally {
    ctx.releaseController(runId);
  }
}

export async function runVideoGeneration(
  ctx: GenerationContext, sessionId: string, runId: string, prompt: string, config: ModelConfigInfo,
): Promise<void> {
  const apiKey = ctx.apiKeyFor(config.provider);
  if (!apiKey) throw runtimeError("pi-adapter.no_api_key_configured_for_video_provider", { p0: config.provider });
  if (!ctx.onGeneratedMedia) throw runtimeError("pi-adapter.video_result_storage_is_not_initialized", {});
  const controller = new AbortController();
  ctx.trackController(runId, controller);
  ctx.push("message.started", { message: { role: "assistant" } }, sessionId, runId);
  try {
    const video = await generateVideo({ config, prompt, apiKey, signal: controller.signal });
    controller.signal.throwIfAborted();
    const savedPath = await ctx.onGeneratedMedia(sessionId, runId, video.stream, video.mimeType, video.extension, controller.signal);
    controller.signal.throwIfAborted();
    ctx.push("message.completed", { message: { role: "assistant", content: [{ type: "text", text: runtimeText("pi-adapter.video_generated", { p0: savedPath }) }] } }, sessionId, runId);
  } finally {
    ctx.releaseController(runId);
  }
}