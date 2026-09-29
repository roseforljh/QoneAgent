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
  if (!response.ok) throw new Error(`视频生成接口 HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
  const value = await response.json() as VideoOperation;
  if (!value || typeof value !== "object") throw new Error("视频生成接口返回格式无效");
  return value;
}

/** Dispatch by API wire format. Google uses its native Veo operation by default. */
export async function generateVideo(input: VideoGenerationRequest): Promise<GeneratedVideo> {
  if (!input.prompt.trim()) throw new Error("视频生成缺少提示词");
  const settings = input.config.config as Record<string, unknown>;
  const videoSettings = settings.videoGeneration && typeof settings.videoGeneration === "object"
    ? settings.videoGeneration as Record<string, unknown> : {};
  const format = videoSettings.format ?? (settings.apiType === "google" ? "google-veo" : undefined);
  if (format === "google-veo") {
    if (settings.apiType !== "google") throw new Error("Google Veo 视频接口需要 Google API 格式");
    return generateGoogleVideo(input);
  }
  if (format !== "openai-videos") throw new Error("视频输出模型需要选择视频生成接口格式");
  const base = modelBaseUrl("openai-compatible", String(videoSettings.baseUrl || settings.baseUrl || ""));
  if (!base) throw new Error("视频生成模型缺少 API 地址");
  const endpoint = new URL(base);
  endpoint.pathname = `${endpoint.pathname.replace(/\/videos\/?$/i, "").replace(/\/+$/, "")}/videos`;
  const headers = { Authorization: `Bearer ${input.apiKey}` };
  const fetchImpl = input.fetchImpl ?? fetch;
  const form = new FormData();
  form.set("model", input.config.model);
  form.set("prompt", input.prompt);
  let operation = await jsonResponse(await fetchImpl(endpoint, { method: "POST", headers, body: form, signal: input.signal }));
  if (typeof operation.id !== "string" || !operation.id) throw new Error("视频生成接口未返回任务 ID");
  const operationUrl = new URL(endpoint);
  operationUrl.pathname = `${endpoint.pathname.replace(/\/+$/, "")}/${encodeURIComponent(operation.id)}`;
  while (operation.status !== "completed") {
    input.signal.throwIfAborted();
    if (operation.status === "failed" || operation.status === "cancelled" || operation.status === "canceled") {
      throw new Error(`视频生成失败：${JSON.stringify(operation.error ?? operation.status)}`);
    }
    await delay(input.pollIntervalMs ?? 10_000, undefined, { signal: input.signal });
    operation = await jsonResponse(await fetchImpl(operationUrl, { headers, signal: input.signal }));
  }
  if (typeof operation.url !== "string" || !operation.url) throw new Error("视频生成完成但接口未返回视频 URL");
  const downloadUrl = new URL(operation.url, endpoint);
  if (downloadUrl.protocol !== "https:" && downloadUrl.protocol !== "http:") throw new Error("视频生成接口返回了不支持的下载地址");
  const download = await fetchImpl(downloadUrl, {
    headers: downloadUrl.origin === endpoint.origin ? headers : undefined,
    signal: input.signal,
  });
  if (!download.ok) throw new Error(`生成视频下载失败 HTTP ${download.status}: ${(await download.text()).slice(0, 2_000)}`);
  if (!download.body) throw new Error("视频生成接口未返回视频文件");
  if (/^(?:application\/json|text\/)/i.test(download.headers.get("content-type") ?? "")) {
    throw new Error(`视频生成接口未返回视频文件：${(await download.text()).slice(0, 2_000)}`);
  }
  const mimeType = download.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const extension = mimeType && videoTypes[mimeType]
    ? videoTypes[mimeType]
    : /\.(mp4|webm|mov)$/i.exec(downloadUrl.pathname)?.[1]?.toLowerCase();
  if (!extension) throw new Error(`无法识别生成视频的格式：${mimeType ?? "未提供 Content-Type"}`);
  const resolvedMime = Object.entries(videoTypes).find(([, value]) => value === extension)?.[0]!;
  return { stream: download.body, mimeType: resolvedMime, extension };
}
