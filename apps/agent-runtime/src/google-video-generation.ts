import { runtimeError } from "./runtime-localization";
import { setTimeout as delay } from "node:timers/promises";
import { modelBaseUrl } from "@qone/protocol";
import type { GeneratedVideo, VideoGenerationRequest } from "./video-generation.js";

type VeoOperation = {
  name?: unknown;
  done?: unknown;
  error?: unknown;
  response?: {
    generateVideoResponse?: { generatedSamples?: Array<{ video?: { uri?: unknown } }> };
    generatedVideos?: Array<{ video?: { uri?: unknown } }>;
  };
};

async function readOperation(response: Response): Promise<VeoOperation> {
  if (!response.ok) throw runtimeError("google-video-generation.google_veo_api_http", { p0: response.status, p1: (await response.text()).slice(0, 2_000) });
  const result = await response.json() as VeoOperation;
  if (!result || typeof result !== "object") throw runtimeError("google-video-generation.invalid_google_veo_api_response_format", {});
  return result;
}

function operationPath(name: unknown): string {
  if (typeof name !== "string" || !name.split("/").every((part) => part && part !== "." && part !== ".." && /^[\w.-]+$/.test(part))) {
    throw runtimeError("google-video-generation.google_veo_api_returned_no_valid_operation_name", {});
  }
  return name;
}

/** Google REST Veo transport: predictLongRunning, operation polling, file download. */
export async function generateGoogleVideo(input: VideoGenerationRequest): Promise<GeneratedVideo> {
  const settings = input.config.config as Record<string, unknown>;
  const videoSettings = settings.videoGeneration && typeof settings.videoGeneration === "object"
    ? settings.videoGeneration as Record<string, unknown> : {};
  const base = modelBaseUrl("google", String(videoSettings.baseUrl || settings.baseUrl || ""));
  if (!base) throw runtimeError("google-video-generation.the_google_veo_model_has_no_api_url", {});
  const baseUrl = new URL(base);
  const requestUrl = new URL(baseUrl);
  requestUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/models/${encodeURIComponent(input.config.model)}:predictLongRunning`;
  const fetchImpl = input.fetchImpl ?? fetch;
  const headers = { "x-goog-api-key": input.apiKey };
  let operation = await readOperation(await fetchImpl(requestUrl, {
    method: "POST", headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify({ instances: [{ prompt: input.prompt }] }), signal: input.signal,
  }));
  const name = operationPath(operation.name);
  const statusUrl = new URL(baseUrl);
  statusUrl.pathname = `${baseUrl.pathname.replace(/\/+$/, "")}/${name}`;
  while (operation.done !== true) {
    input.signal.throwIfAborted();
    if (operation.error) throw runtimeError("google-video-generation.google_veo_video_generation_failed", { p0: JSON.stringify(operation.error) });
    await delay(input.pollIntervalMs ?? 10_000, undefined, { signal: input.signal });
    operation = await readOperation(await fetchImpl(statusUrl, { headers, signal: input.signal }));
  }
  if (operation.error) throw runtimeError("google-video-generation.google_veo_video_generation_failed", { p0: JSON.stringify(operation.error) });
  const uri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    ?? operation.response?.generatedVideos?.[0]?.video?.uri;
  if (typeof uri !== "string" || !uri) throw runtimeError("google-video-generation.google_veo_finished_but_returned_no_video_url", {});
  let downloadUrl = new URL(uri, baseUrl);
  if (!/^https?:$/.test(downloadUrl.protocol)) throw runtimeError("google-video-generation.google_veo_returned_an_unsupported_download_url", {});
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 10; redirect++) {
    response = await fetchImpl(downloadUrl, {
      headers: downloadUrl.origin === baseUrl.origin ? headers : undefined,
      redirect: "manual", signal: input.signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw runtimeError("google-video-generation.google_veo_video_download_redirect_has_no_url", {});
    await response.body?.cancel();
    downloadUrl = new URL(location, downloadUrl);
    if (!/^https?:$/.test(downloadUrl.protocol)) throw runtimeError("google-video-generation.invalid_google_veo_video_download_redirect_url", {});
    response = undefined;
  }
  if (!response) throw runtimeError("google-video-generation.too_many_google_veo_video_download_redirects", {});
  if (!response.ok) throw runtimeError("google-video-generation.google_veo_video_download_http", { p0: response.status, p1: (await response.text()).slice(0, 2_000) });
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
    throw runtimeError("google-video-generation.google_veo_video_download_returned_content_other_than_mp4", { p0: contentType });
  }
  if (!response.body) throw runtimeError("google-video-generation.google_veo_video_download_returned_no_file", {});
  return { stream: response.body, mimeType: "video/mp4", extension: "mp4" };
}
