import { createHash } from "node:crypto";
import type {
  AssistantMessageEventStream,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import type { MessageAttachmentInfo } from "@qone/protocol";

const GOOGLE_API_VERSION = "/v1beta";
const LARGE_MEDIA_BYTES = 4 * 1024 * 1024;
const FILE_PROCESSING_TIMEOUT_MS = 90_000;
const FILE_PROCESSING_POLL_MS = 1_000;

type GooglePart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
};

type GooglePayload = {
  contents?: Array<{ role?: string; parts?: GooglePart[] }>;
};

type GoogleFile = {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
};

const uploadedFiles = new Map<string, Promise<GoogleFile>>();

function dataBytes(base64: string): number {
  return Math.floor(base64.length * 0.75);
}

function apiRoot(baseUrl: string): URL {
  const url = new URL(baseUrl || `https://generativelanguage.googleapis.com${GOOGLE_API_VERSION}`);
  url.search = "";
  url.hash = "";
  url.pathname = url.pathname.replace(/\/+$/, "");
  if (!/\/v\d+(?:beta)?$/i.test(url.pathname)) url.pathname += GOOGLE_API_VERSION;
  return url;
}

function filesEndpoint(baseUrl: string): URL {
  const root = apiRoot(baseUrl);
  root.pathname = `/upload${root.pathname}/files`;
  return root;
}

function fileResourceUrl(baseUrl: string, name: string): URL {
  const root = apiRoot(baseUrl);
  root.pathname = `${root.pathname}/${name.replace(/^\/+/, "")}`;
  return root;
}

function withApiKey(url: URL, apiKey: string): URL {
  const result = new URL(url);
  result.searchParams.set("key", apiKey);
  return result;
}

function responseFile(value: unknown): GoogleFile {
  if (!value || typeof value !== "object") throw new Error("Gemini 文件上传返回了无效结果");
  const record = value as { file?: GoogleFile } & GoogleFile;
  const file = record.file ?? record;
  if (!file.uri || !file.name) throw new Error("Gemini 文件上传缺少文件 URI");
  return file;
}

async function readResponseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return body ? `Gemini 文件接口 HTTP ${response.status}: ${body.slice(0, 500)}` : `Gemini 文件接口 HTTP ${response.status}`;
}

async function waitForActiveFile(file: GoogleFile, baseUrl: string, apiKey: string): Promise<GoogleFile> {
  if (!file.state || file.state === "ACTIVE") return file;
  const startedAt = Date.now();
  while (Date.now() - startedAt < FILE_PROCESSING_TIMEOUT_MS) {
    await new Promise((resolve) => setTimeout(resolve, FILE_PROCESSING_POLL_MS));
    const response = await fetch(withApiKey(fileResourceUrl(baseUrl, file.name!), apiKey), { headers: { Accept: "application/json" } });
    if (!response.ok) throw new Error(await readResponseError(response));
    const next = responseFile(await response.json());
    if (next.state === "FAILED") throw new Error("Gemini 无法处理这个音视频文件");
    if (!next.state || next.state === "ACTIVE") return next;
    file = next;
  }
  throw new Error("Gemini 音视频处理超时，请稍后重试");
}

async function uploadGoogleFile(baseUrl: string, apiKey: string, mimeType: string, data: string, displayName: string): Promise<GoogleFile> {
  const bytes = Buffer.from(data, "base64");
  const start = await fetch(withApiKey(filesEndpoint(baseUrl), apiKey), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({ file: { displayName } }),
  });
  if (!start.ok) throw new Error(await readResponseError(start));
  const uploadUrl = start.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("Gemini 文件接口未返回上传地址");
  const finish = await fetch(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(bytes.byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes,
  });
  if (!finish.ok) throw new Error(await readResponseError(finish));
  return waitForActiveFile(responseFile(await finish.json()), baseUrl, apiKey);
}

function cachedUpload(baseUrl: string, apiKey: string, part: { mimeType: string; data: string; name: string }): Promise<GoogleFile> {
  const key = createHash("sha256").update(`${baseUrl}\0${part.mimeType}\0${part.data}`).digest("hex");
  const existing = uploadedFiles.get(key);
  if (existing) return existing;
  const pending = uploadGoogleFile(baseUrl, apiKey, part.mimeType, part.data, part.name).catch((error) => {
    uploadedFiles.delete(key);
    throw error;
  });
  uploadedFiles.set(key, pending);
  return pending;
}

export function youtubeUrlsFromText(value: string): string[] {
  const result: string[] = [];
  const pattern = /https?:\/\/(?:www\.|m\.)?(?:youtube\.com\/(?:watch\?[^\s<>"')，。！？；：、]+|shorts\/[^\s<>"/')，。！？；：、]+|embed\/[^\s<>"/')，。！？；：、]+)|youtu\.be\/[^\s<>"/')，。！？；：、]+)/gi;
  for (const match of value.matchAll(pattern)) {
    const url = match[0]!.replace(/[.,!?;:，。！？；：、]+$/, "");
    if (!result.includes(url)) result.push(url);
  }
  return result;
}

export function googleMediaContent(attachments: readonly MessageAttachmentInfo[] = []): ImageContent[] {
  return attachments.flatMap((attachment) => {
    const match = /^data:([^,;]+);base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data);
    if (!match) return [];
    const mimeType = (attachment.mimeType || match[1]!).toLowerCase();
    if (!(attachment.type === "image" || /^(?:audio|video)\//.test(mimeType) || mimeType === "application/pdf")) return [];
    return [{ type: "image" as const, data: match[2]!, mimeType }];
  });
}

export async function prepareGooglePayload(payload: unknown, model: Model<any>, apiKey: string | undefined): Promise<GooglePayload> {
  const next = payload as GooglePayload;
  if (!Array.isArray(next.contents)) return next;
  const seenYouTube = new Set<string>();
  const mediaUploads: Array<{ part: GooglePart; data: string; name: string }> = [];
  for (const content of next.contents) {
    if (!Array.isArray(content.parts)) continue;
    const additions: GooglePart[] = [];
    for (const part of content.parts) {
      if (part.text) {
        for (const url of youtubeUrlsFromText(part.text)) {
          if (!seenYouTube.has(url)) {
            seenYouTube.add(url);
            additions.push({ fileData: { mimeType: "video/*", fileUri: url } });
          }
        }
      }
      const inline = part.inlineData;
      if (inline && /^(?:audio|video)\//.test(inline.mimeType) && dataBytes(inline.data) >= LARGE_MEDIA_BYTES) {
        if (!apiKey) throw new Error("Gemini 音视频上传需要 API Key");
        mediaUploads.push({ part, data: inline.data, name: `qone-${inline.mimeType.replace(/[^a-z0-9]+/gi, "-")}` });
      }
    }
    if (additions.length) content.parts.push(...additions);
  }
  if (mediaUploads.length) {
    if (!apiKey) throw new Error("Gemini 音视频上传需要 API Key");
    await Promise.all(mediaUploads.map(async ({ part, data, name }) => {
      const mimeType = part.inlineData!.mimeType;
      const file = await cachedUpload(model.baseUrl, apiKey, { mimeType, data, name });
      if (!file.uri) throw new Error("Gemini 文件接口未返回文件 URI");
      part.fileData = { mimeType, fileUri: file.uri };
      delete part.inlineData;
    }));
  }
  return next;
}

export function googleStreamSimple(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
): AssistantMessageEventStream {
  const onPayload = options?.onPayload;
  return streamGoogle(model as never, context, {
    ...options,
    onPayload: async (payload, requestModel) => {
      const rewritten = await prepareGooglePayload(payload, requestModel as Model<any>, options?.apiKey);
      return onPayload ? (await onPayload(rewritten, requestModel)) ?? rewritten : rewritten;
    },
  });
}
