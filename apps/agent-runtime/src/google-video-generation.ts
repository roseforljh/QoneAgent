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
  if (!response.ok) throw new Error(`Google Veo 接口 HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
  const result = await response.json() as VeoOperation;
  if (!result || typeof result !== "object") throw new Error("Google Veo 接口返回格式无效");
  return result;
}

function operationPath(name: unknown): string {
  if (typeof name !== "string" || !name.split("/").every((part) => part && part !== "." && part !== ".." && /^[\w.-]+$/.test(part))) {
    throw new Error("Google Veo 接口未返回有效任务名称");
  }
  return name;
}

/** Google REST Veo transport: predictLongRunning, operation polling, file download. */
export async function generateGoogleVideo(input: VideoGenerationRequest): Promise<GeneratedVideo> {
  const settings = input.config.config as Record<string, unknown>;
  const videoSettings = settings.videoGeneration && typeof settings.videoGeneration === "object"
    ? settings.videoGeneration as Record<string, unknown> : {};
  const base = modelBaseUrl("google", String(videoSettings.baseUrl || settings.baseUrl || ""));
  if (!base) throw new Error("Google Veo 模型缺少 API 地址");
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
    if (operation.error) throw new Error(`Google Veo 视频生成失败：${JSON.stringify(operation.error)}`);
    await delay(input.pollIntervalMs ?? 10_000, undefined, { signal: input.signal });
    operation = await readOperation(await fetchImpl(statusUrl, { headers, signal: input.signal }));
  }
  if (operation.error) throw new Error(`Google Veo 视频生成失败：${JSON.stringify(operation.error)}`);
  const uri = operation.response?.generateVideoResponse?.generatedSamples?.[0]?.video?.uri
    ?? operation.response?.generatedVideos?.[0]?.video?.uri;
  if (typeof uri !== "string" || !uri) throw new Error("Google Veo 生成完成但未返回视频地址");
  let downloadUrl = new URL(uri, baseUrl);
  if (!/^https?:$/.test(downloadUrl.protocol)) throw new Error("Google Veo 返回了不支持的下载地址");
  let response: Response | undefined;
  for (let redirect = 0; redirect <= 10; redirect++) {
    response = await fetchImpl(downloadUrl, {
      headers: downloadUrl.origin === baseUrl.origin ? headers : undefined,
      redirect: "manual", signal: input.signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) break;
    const location = response.headers.get("location");
    if (!location) throw new Error("Google Veo 视频下载重定向缺少地址");
    await response.body?.cancel();
    downloadUrl = new URL(location, downloadUrl);
    if (!/^https?:$/.test(downloadUrl.protocol)) throw new Error("Google Veo 视频下载重定向地址无效");
    response = undefined;
  }
  if (!response) throw new Error("Google Veo 视频下载重定向过多");
  if (!response.ok) throw new Error(`Google Veo 视频下载 HTTP ${response.status}: ${(await response.text()).slice(0, 2_000)}`);
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  if (contentType && contentType !== "video/mp4" && contentType !== "application/octet-stream") {
    throw new Error(`Google Veo 视频下载返回了非 MP4 内容：${contentType}`);
  }
  if (!response.body) throw new Error("Google Veo 视频下载没有返回文件");
  return { stream: response.body, mimeType: "video/mp4", extension: "mp4" };
}
