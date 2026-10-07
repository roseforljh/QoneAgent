import { runtimeText, runtimeError } from "./runtime-localization";
import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai";
import type {
  AssistantMessageEvent,
  AssistantMessageEventStream,
  ImageContent,
  Model,
  SimpleStreamOptions,
  TranscriptContext,
} from "@earendil-works/pi-ai";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import type { MessageAttachmentInfo } from "@qone/protocol";
import { reportMediaPhase } from "./media-phase.js";

const GOOGLE_API_VERSION = "/v1beta";
const LARGE_MEDIA_BYTES = 4 * 1024 * 1024;
const FILE_PROCESSING_TIMEOUT_MS = 30 * 60_000;
const FILE_PROCESSING_POLL_MS = 1_000;
const UPLOAD_CACHE_AGE_MS = 47 * 60 * 60_000;
const markerSecret = randomBytes(32);
export const MEDIA_MARKER = /\[\[QONE_MEDIA:([A-Za-z0-9_-]+):([a-f0-9]{64})\]\]/g;

type GooglePart = {
  text?: string;
  inlineData?: { mimeType: string; data: string };
  fileData?: { mimeType: string; fileUri: string };
  functionResponse?: { response?: Record<string, unknown> };
};

type GooglePayload = {
  contents?: Array<{ role?: string; parts?: GooglePart[] }>;
};

type GoogleFile = {
  name?: string;
  uri?: string;
  mimeType?: string;
  state?: string;
  error?: { message?: string };
};

const uploadedFiles = new Map<string, { file: Promise<GoogleFile>; expiresAt: number }>();

export function localMediaMarker(path: string, mimeType: string, temporary = false): string {
  const encoded = Buffer.from(JSON.stringify({ path, mimeType, temporary })).toString("base64url");
  const signature = createHmac("sha256", markerSecret).update(encoded).digest("hex");
  return `[[QONE_MEDIA:${encoded}:${signature}]]`;
}

function decodeLocalMedia(encoded: string, signature: string): { path: string; mimeType: string; temporary: boolean } {
  const expected = createHmac("sha256", markerSecret).update(encoded).digest("hex");
  if (!timingSafeEqual(Buffer.from(expected, "hex"), Buffer.from(signature, "hex"))) throw runtimeError("google-media.invalid_local_media_attachment_reference", {});
  const value = JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as { path?: unknown; mimeType?: unknown; temporary?: unknown };
  if (typeof value.path !== "string" || !isAbsolute(value.path) || typeof value.mimeType !== "string" || !/^(?:audio|video)\//i.test(value.mimeType)) {
    throw runtimeError("google-media.invalid_local_media_attachment_path_or_type", {});
  }
  return { path: value.path, mimeType: value.mimeType, temporary: value.temporary === true };
}

export function verifiedLocalMedia(encoded: string, signature: string): ReturnType<typeof decodeLocalMedia> | undefined {
  try { return decodeLocalMedia(encoded, signature); } catch { return undefined; }
}

function dataBytes(base64: string): number {
  return Math.floor(base64.length * 0.75);
}

function containsGoogleMedia(payload: unknown): boolean {
  try {
    const value = JSON.stringify(payload);
    return Boolean(value && (value.includes("QONE_MEDIA") || value.includes("inlineData") || value.includes("fileData")));
  } catch {
    return false;
  }
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
  if (!value || typeof value !== "object") throw runtimeError("google-media.gemini_file_upload_returned_an_invalid_result", {});
  const record = value as { file?: GoogleFile } & GoogleFile;
  const file = record.file ?? record;
  if (!file.uri || !file.name) throw runtimeError("google-media.gemini_file_upload_returned_no_file_uri", {});
  return file;
}

async function readResponseError(response: Response): Promise<string> {
  const body = await response.text().catch(() => "");
  return body ? runtimeText("google-media.gemini_files_api_http", { p0: response.status, p1: body.slice(0, 500) }) : runtimeText("google-media.gemini_files_api_http_details_1", { p0: response.status });
}

async function readUploadSession(response: Response): Promise<{ url?: string; body: string }> {
  const headerUrl = response.headers.get("x-goog-upload-url");
  if (headerUrl?.trim()) return { url: headerUrl.trim(), body: "" };
  const body = await response.text().catch(() => "");
  return { body };
}

async function waitForActiveFile(file: GoogleFile, baseUrl: string, apiKey: string, signal?: AbortSignal): Promise<GoogleFile> {
  if (file.state === "FAILED") throw runtimeError("google-media.gemini_could_not_process_this_audio_or_video_file", { p0: file.error?.message ? `：${file.error.message}` : "" });
  if (!file.state || file.state === "ACTIVE") return file;
  const startedAt = Date.now();
  while (Date.now() - startedAt < FILE_PROCESSING_TIMEOUT_MS) {
    await delay(FILE_PROCESSING_POLL_MS, undefined, { signal });
    const response = await fetch(withApiKey(fileResourceUrl(baseUrl, file.name!), apiKey), { headers: { Accept: "application/json" }, signal });
    if (!response.ok) throw new Error(await readResponseError(response));
    const next = responseFile(await response.json());
    if (next.state === "FAILED") throw runtimeError("google-media.gemini_could_not_process_this_audio_or_video_file", { p0: next.error?.message ? `：${next.error.message}` : "" });
    if (!next.state || next.state === "ACTIVE") return next;
    file = next;
  }
  throw runtimeError("google-media.gemini_audio_video_processing_timed_out_please_try_again", {});
}

async function uploadGoogleFile(baseUrl: string, apiKey: string, mimeType: string, data: string | { path: string; size: number }, displayName: string, signal?: AbortSignal): Promise<GoogleFile> {
  const bytes = typeof data === "string" ? Buffer.from(data, "base64") : undefined;
  const byteLength = bytes?.byteLength ?? (data as { size: number }).size;
  const start = await fetch(withApiKey(filesEndpoint(baseUrl), apiKey), {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(byteLength),
      "X-Goog-Upload-Header-Content-Type": mimeType,
    },
    body: JSON.stringify({ file: { displayName } }),
    signal,
  });
  if (!start.ok) throw new Error(await readResponseError(start));
  const uploadSession = await readUploadSession(start);
  if (!uploadSession.url) {
    const endpoint = filesEndpoint(baseUrl);
    const location = `${endpoint.origin}${endpoint.pathname}`;
    if (/text\/html/i.test(start.headers.get("content-type") ?? "") || /^\s*(?:<!doctype html|<html)/i.test(uploadSession.body)) {
      throw runtimeError("google-media.gemini_video_has_not_been_uploaded_files_api_returned", { p0: location, p1: start.status });
    }
    const detail = uploadSession.body ? `：${uploadSession.body.slice(0, 500)}` : "";
    throw runtimeError("google-media.gemini_files_api_returned_no_upload_url_http_content", { p0: location, p1: start.status, p2: start.headers.get("content-type") ?? runtimeText("google-media.not_provided"), p3: detail });
  }
  const finish = await fetch(uploadSession.url, {
    method: "POST",
    headers: {
      "Content-Length": String(byteLength),
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: bytes ?? Bun.file((data as { path: string }).path),
    signal,
  });
  if (!finish.ok) throw new Error(await readResponseError(finish));
  return waitForActiveFile(responseFile(await finish.json()), baseUrl, apiKey, signal);
}

function cachedUpload(baseUrl: string, apiKey: string, part: { mimeType: string; data: string | { path: string; size: number; modified: number }; name: string }, signal?: AbortSignal): Promise<GoogleFile> {
  const identity = typeof part.data === "string" ? part.data : `${part.data.path}\0${part.data.size}\0${part.data.modified}`;
  const key = createHash("sha256").update(`${baseUrl}\0${apiKey}\0${part.mimeType}\0${identity}`).digest("hex");
  const existing = uploadedFiles.get(key);
  if (existing && existing.expiresAt > Date.now()) return existing.file;
  const pending = uploadGoogleFile(baseUrl, apiKey, part.mimeType, part.data, part.name, signal).catch((error) => {
    uploadedFiles.delete(key);
    throw error;
  });
  uploadedFiles.set(key, { file: pending, expiresAt: Date.now() + UPLOAD_CACHE_AGE_MS });
  return pending;
}

async function uploadLocalMedia(path: string, mimeType: string, model: Model<any>, apiKey: string, signal?: AbortSignal): Promise<GoogleFile> {
  const info = await stat(path);
  if (!info.isFile()) throw runtimeError("google-media.the_local_media_attachment_is_no_longer_a_file", {});
  return cachedUpload(model.baseUrl, apiKey, { mimeType, data: { path, size: info.size, modified: info.mtimeMs }, name: path.split(/[\\/]/).at(-1) ?? "media" }, signal);
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

export function googleMediaContent(attachments: readonly MessageAttachmentInfo[] = [], allowedInput?: readonly string[]): ImageContent[] {
  return attachments.flatMap((attachment) => {
    if (attachment.type === "folder") return [];
    const capability = attachment.mimeType.startsWith("video/") ? "video"
      : attachment.mimeType.startsWith("audio/") ? "audio"
        : attachment.mimeType.startsWith("image/") || attachment.type === "image" ? "image" : undefined;
    if (capability && allowedInput && !allowedInput.includes(capability)) return [];
    const match = /^data:([^,;]+);base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data);
    if (!match) return [];
    const mimeType = (attachment.mimeType || match[1]!).toLowerCase();
    if (!(/^(?:image|audio|video)\//.test(mimeType) || mimeType === "application/pdf")) return [];
    return [{ type: "image" as const, data: match[2]!, mimeType }];
  });
}

export async function prepareGooglePayload(payload: unknown, model: Model<any>, apiKey: string | undefined, signal?: AbortSignal, allowYouTube = true, allowedInput?: readonly string[]): Promise<GooglePayload> {
  const next = payload as GooglePayload;
  if (!Array.isArray(next.contents)) return next;
  const seenYouTube = new Set<string>();
  const mediaUploads: Array<{ part: GooglePart; data: string; name: string }> = [];
  const localUploads: Array<{ part: GooglePart; path: string; mimeType: string }> = [];
  for (const content of next.contents) {
    if (content.role !== "user" || !Array.isArray(content.parts)) continue;
    const rewrittenParts: GooglePart[] = [];
    for (const part of content.parts) {
      const inline = part.inlineData;
      if (inline && /^(?:audio|video)\//.test(inline.mimeType) && allowedInput
        && !allowedInput.includes(inline.mimeType.startsWith("video/") ? "video" : "audio")) {
        rewrittenParts.push({ text: runtimeText("google-media.the_current_model_lacks_the_required_media_input_capability") });
        continue;
      }
      const fileData = part.fileData;
      if (fileData && /^(?:audio|video)\//.test(fileData.mimeType) && allowedInput
        && !allowedInput.includes(fileData.mimeType.startsWith("video/") ? "video" : "audio")) {
        rewrittenParts.push({ text: runtimeText("google-media.the_current_model_lacks_the_required_media_input_capability") });
        continue;
      }
      if (part.text) {
        const sourceText = part.text;
        const markers = [...sourceText.matchAll(MEDIA_MARKER)];
        if (markers.length) {
          let offset = 0;
          for (const marker of markers) {
            const before = sourceText.slice(offset, marker.index);
            if (before) rewrittenParts.push({ text: before });
            const media = verifiedLocalMedia(marker[1]!, marker[2]!);
            const mediaCapability = media?.mimeType.startsWith("video/") ? "video" : "audio";
            if (!media) {
              rewrittenParts.push({ text: runtimeText("google-media.the_previous_session_s_media_reference_has_expired_provide") });
            } else if (allowedInput && !allowedInput.includes(mediaCapability)) {
              rewrittenParts.push({ text: runtimeText("google-media.the_current_model_lacks_the_required_media_input_capability") });
            } else if (media.temporary && !await stat(media.path).then((info) => info.isFile()).catch(() => false)) {
              rewrittenParts.push({ text: runtimeText("google-media.previously_processed_temporary_media_has_been_cleaned_up_retrieve") });
            } else {
              const localPart: GooglePart = {};
              rewrittenParts.push(localPart);
              localUploads.push({ part: localPart, ...media });
            }
            offset = marker.index! + marker[0].length;
          }
          const after = sourceText.slice(offset);
          if (after) rewrittenParts.push({ text: after });
        } else rewrittenParts.push(part);
        for (const url of allowYouTube ? youtubeUrlsFromText(sourceText) : []) {
          if (!seenYouTube.has(url)) {
            seenYouTube.add(url);
            rewrittenParts.push({ fileData: { mimeType: "video/*", fileUri: url } });
          }
        }
      } else if (typeof part.functionResponse?.response?.output === "string") {
        const output = part.functionResponse.response.output;
        const markers = [...output.matchAll(MEDIA_MARKER)];
        if (markers.length) {
          const available: Array<{ path: string; mimeType: string }> = [];
          let rejected = false;
          for (const marker of markers) {
            const media = verifiedLocalMedia(marker[1]!, marker[2]!);
            if (!media) continue;
            const mediaCapability = media.mimeType.startsWith("video/") ? "video" : "audio";
            if (allowedInput && !allowedInput.includes(mediaCapability)) { rejected = true; continue; }
            if (await stat(media.path).then((info) => info.isFile()).catch(() => false)) available.push(media);
          }
          rewrittenParts.push({ ...part, functionResponse: {
            ...part.functionResponse,
            response: { ...part.functionResponse.response, output: output.replace(MEDIA_MARKER,
              available.length ? runtimeText("google-media.media_files_are_attached_after_the_tool_result") : rejected
                ? runtimeText("google-media.the_current_model_lacks_the_required_media_input_capability")
                : runtimeText("google-media.previously_downloaded_temporary_media_has_been_cleaned_up_download")) },
          } });
          for (const media of available) {
            const localPart: GooglePart = {};
            rewrittenParts.push(localPart);
            localUploads.push({ part: localPart, ...media });
          }
        } else rewrittenParts.push(part);
      } else rewrittenParts.push(part);
      if (inline && /^(?:audio|video)\//.test(inline.mimeType) && dataBytes(inline.data) >= LARGE_MEDIA_BYTES) {
        if (!apiKey) throw runtimeError("google-media.gemini_audio_video_upload_requires_an_api_key", {});
        mediaUploads.push({ part, data: inline.data, name: `qone-${inline.mimeType.replace(/[^a-z0-9]+/gi, "-")}` });
      }
    }
    content.parts = rewrittenParts;
  }
  if (mediaUploads.length) {
    if (!apiKey) throw runtimeError("google-media.gemini_audio_video_upload_requires_an_api_key", {});
    await Promise.all(mediaUploads.map(async ({ part, data, name }) => {
      const mimeType = part.inlineData!.mimeType;
      const file = await cachedUpload(model.baseUrl, apiKey, { mimeType, data, name }, signal);
      if (!file.uri) throw runtimeError("google-media.gemini_files_api_returned_no_file_uri", {});
      part.fileData = { mimeType, fileUri: file.uri };
      delete part.inlineData;
    }));
  }
  if (localUploads.length) {
    if (!apiKey) throw runtimeError("google-media.gemini_audio_video_upload_requires_an_api_key", {});
    await Promise.all(localUploads.map(async ({ part, path, mimeType }) => {
      const file = await uploadLocalMedia(path, mimeType, model, apiKey, signal);
      part.fileData = { mimeType, fileUri: file.uri! };
    }));
  }
  return next;
}

export function googleStreamSimple(
  model: Model<any>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  allowYouTube = true,
  allowedInput?: readonly string[],
): AssistantMessageEventStream {
  const createStream = (streamOptions?: SimpleStreamOptions) => {
    const onPayload = streamOptions?.onPayload;
    return streamGoogle(model as never, context, {
      ...streamOptions,
      onPayload: async (payload, requestModel) => {
        const hasMedia = containsGoogleMedia(payload);
        if (hasMedia) reportMediaPhase("started");
        const rewritten = await prepareGooglePayload(payload, requestModel as Model<any>, streamOptions?.apiKey, streamOptions?.signal, allowYouTube, allowedInput);
        if (hasMedia) reportMediaPhase("completed");
        return onPayload ? (await onPayload(rewritten, requestModel)) ?? rewritten : rewritten;
      },
    });
  };
  const primary = createStream(options);
  if (!options?.reasoning || options.reasoning === "minimal") return primary;

  const recovered = createAssistantMessageEventStream();
  void (async () => {
    const buffered: AssistantMessageEvent[] = [];
    let visibleContent = false;
    const hasThinking = (events: readonly AssistantMessageEvent[]) => events.some((event) => event.type === "thinking_start" || event.type === "thinking_delta" || event.type === "thinking_end");
    const hasUsableOutput = (message: Extract<AssistantMessageEvent, { type: "done" }>['message']) => message.content.some((part) => (part.type === "text" && part.text.trim().length > 0) || part.type === "toolCall");
    const isRecoverableError = (event: AssistantMessageEvent) => event.type === "error" && /Google stream ended without a finish reason|operation timed out/i.test(event.error.errorMessage ?? "");
    const shouldRecover = (event: AssistantMessageEvent) => {
      if (visibleContent || !hasThinking([...buffered, event])) return false;
      if (isRecoverableError(event)) return true;
      return event.type === "done" && !hasUsableOutput(event.message);
    };
    const retryWithMinimalThinking = async () => {
      const retry = createStream({ ...options, reasoning: "minimal" });
      for await (const event of retry) {
        recovered.push(event);
        if (event.type === "done" || event.type === "error") return;
      }
    };
    for await (const event of primary) {
      if (shouldRecover(event)) {
        await retryWithMinimalThinking();
        return;
      }
      if (!visibleContent && (event.type === "text_start" || event.type === "text_delta" || event.type === "toolcall_start" || event.type === "toolcall_delta" || event.type === "toolcall_end")) {
        visibleContent = true;
        for (const pending of buffered) recovered.push(pending);
        buffered.length = 0;
      }
      if (visibleContent) recovered.push(event);
      else buffered.push(event);
      if (event.type === "done" || event.type === "error") {
        for (const pending of buffered) recovered.push(pending);
        return;
      }
    }
  })();
  return recovered;
}
