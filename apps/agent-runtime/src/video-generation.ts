import { runtimeText, runtimeError } from "./runtime-localization";
import { setTimeout as delay } from "node:timers/promises";
import { modelBaseUrl, type ModelConfigInfo } from "@qone/protocol";
import { generateGoogleVideo } from "./google-video-generation.js";

export interface VideoGenerationRequest {
  config: ModelConfigInfo;
  prompt: string;
  apiKey: string;
  signal: AbortSignal;
  fetchImpl?: typeof fetch;
  pollIntervalMs?: number;
}

export interface GeneratedVideo {
  stream: ReadableStream<Uint8Array>;
  mimeType: string;
  extension: string;
}

const videoTypes: Record<string, string> = {
  "video/mp4": "mp4", "video/webm": "webm", "video/quicktime": "mov",
};

type VideoOperation = { id?: unknown; status?: unknown; url?: unknown; error?: unknown };

async function jsonResponse(response: Response): Promise<VideoOperation> {
  if (!response.ok) throw runtimeError("video-generation.video_generation_api_http", { p0: response.status, p1: (await response.text()).slice(0, 2_000) });
  const value = await response.json() as VideoOperation;
  if (!value || typeof value !== "object") throw runtimeError("video-generation.invalid_video_generation_api_response_format", {});
  return value;
}

/** Dispatch by API wire format. Google uses its native Veo operation by default. */
export async function generateVideo(input: VideoGenerationRequest): Promise<GeneratedVideo> {
  if (!input.prompt.trim()) throw runtimeError("video-generation.video_generation_requires_a_prompt", {});
  const settings = input.config.config as Record<string, unknown>;
  const videoSettings = settings.videoGeneration && typeof settings.videoGeneration === "object"
    ? settings.videoGeneration as Record<string, unknown> : {};
  const format = videoSettings.format ?? (settings.apiType === "google" ? "google-veo" : undefined);
  if (format === "google-veo") {
    if (settings.apiType !== "google") throw runtimeError("video-generation.google_veo_video_generation_requires_the_google_api_format", {});
    return generateGoogleVideo(input);
  }
  if (format !== "openai-videos") throw runtimeError("video-generation.select_a_video_generation_api_format_for_the_video", {});
  const base = modelBaseUrl("openai-compatible", String(videoSettings.baseUrl || settings.baseUrl || ""));
  if (!base) throw runtimeError("video-generation.the_video_generation_model_has_no_api_url", {});
  const endpoint = new URL(base);
  endpoint.pathname = `${endpoint.pathname.replace(/\/videos\/?$/i, "").replace(/\/+$/, "")}/videos`;
  const headers = { Authorization: `Bearer ${input.apiKey}` };
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  form.set("model", input.config.model);
  form.set("prompt", input.prompt);
  let operation = await jsonResponse(await fetchImpl(endpoint, { method: "POST", headers, body: form, signal: input.signal }));
  if (typeof operation.id !== "string" || !operation.id) throw runtimeError("video-generation.video_generation_api_returned_no_task_id", {});
  const operationUrl = new URL(endpoint);
  operationUrl.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${encodeURIComponent(operation.id)}`;
  while (operation.status !== "completed") {
    input.signal.throwIfAborted();
    if (operation.status === "failed" || operation.status === "cancelled" || operation.status === "canceled") {
      throw runtimeError("video-generation.video_generation_failed", { p0: JSON.stringify(operation.error ?? operation.status) });
    }
    await delay(input.pollIntervalMs ?? 10_000, undefined, { signal: input.signal });
    operation = await jsonResponse(await fetchImpl(operationUrl, { headers, signal: input.signal }));
  }
  if (typeof operation.url !== "string" || !operation.url) throw runtimeError("video-generation.video_generation_completed_but_the_api_returned_no_video", {});
  const downloadUrl = new URL(operation.url, endpoint);
  if (downloadUrl.protocol !== "https:" && downloadUrl.protocol !== "http:") throw runtimeError("video-generation.video_generation_api_returned_an_unsupported_download_url", {});
  const download = await fetchImpl(downloadUrl, {
    headers: downloadUrl.origin === endpoint.origin ? headers : undefined,
    signal: input.signal,
  });
  if (!download.ok) throw runtimeError("video-generation.generated_video_download_failed_http", { p0: download.status, p1: (await download.text()).slice(0, 2_000) });
  if (!download.body) throw runtimeError("video-generation.video_generation_api_returned_no_video_file", {});
  if (/^(?:application\/json|text\/)/i.test(download.headers.get("content-type") ?? "")) {
    throw runtimeError("video-generation.video_generation_api_returned_no_video_file_details_1", { p0: (await download.text()).slice(0, 2_000) });
  }
  const mimeType = download.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const extension = mimeType && videoTypes[mimeType]
    ? videoTypes[mimeType]
    : /\.(mp4|webm|mov)$/i.exec(downloadUrl.pathname)?.[1]?.toLowerCase();
  if (!extension) throw runtimeError("video-generation.could_not_identify_the_generated_video_format", { p0: mimeType ?? runtimeText("video-generation.content_type_not_provided") });
  const resolvedMime = Object.entries(videoTypes).find(([, value]) => value === extension)?.[0]!;
  return { stream: download.body, mimeType: resolvedMime, extension };
}
