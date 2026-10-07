import { runtimeText, runtimeError } from "./runtime-localization";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { qoneTemporaryDir } from "@qone/shared";
import path from "node:path";
import { promisify } from "node:util";
import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAICompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { MEDIA_MARKER, verifiedLocalMedia } from "./google-media.js";
import { ffmpegExecutable } from "./reach-channels.js";

const execFileAsync = promisify(execFile);

type CompletionPart = { type: string; [key: string]: unknown };
type CompletionMessage = { role?: string; content?: string | CompletionPart[]; [key: string]: unknown };
type CompletionPayload = { messages?: CompletionMessage[]; [key: string]: unknown };
type AudioPart = { type: "input_audio"; input_audio: { data: string; format: "mp3" | "wav" } };
type VideoPart = { type: "video_url"; video_url: { url: string } };
type MediaPart = AudioPart | VideoPart;

async function audioPart(data: Buffer | string, mimeType: string, signal?: AbortSignal): Promise<AudioPart> {
  const format = /^(?:audio\/mpeg|audio\/mp3)$/i.test(mimeType) ? "mp3"
    : /^(?:audio\/wav|audio\/x-wav|audio\/wave)$/i.test(mimeType) ? "wav" : undefined;
  if (format) {
    const bytes = typeof data === "string" ? await readFile(data) : data;
    return { type: "input_audio", input_audio: { data: bytes.toString("base64"), format } };
  }
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw runtimeError("openai-audio.chat_completions_audio_input_requires_mp3_wav_ffmpeg_was", { p0: mimeType });
  const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-openai-audio-"));
  try {
    const source = typeof data === "string" ? data : path.join(directory, "input");
    if (typeof data !== "string") await writeFile(source, data);
    const output = path.join(directory, "audio.mp3");
    await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", source, "-vn", "-c:a", "libmp3lame", output],
      { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
    return { type: "input_audio", input_audio: { data: (await readFile(output)).toString("base64"), format: "mp3" } };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function videoPart(data: Buffer | string, mimeType: string): Promise<VideoPart> {
  const bytes = typeof data === "string" ? await readFile(data) : data;
  return { type: "video_url", video_url: { url: `data:${mimeType};base64,${bytes.toString("base64")}` } };
}

async function textParts(value: string, allowedInput: readonly string[], signal?: AbortSignal): Promise<{ parts: CompletionPart[]; media: MediaPart[] }> {
  const parts: CompletionPart[] = [];
  const nativeParts: MediaPart[] = [];
  let offset = 0;
  for (const match of value.matchAll(MEDIA_MARKER)) {
    if (match.index! > offset) parts.push({ type: "text", text: value.slice(offset, match.index) });
    const media = verifiedLocalMedia(match[1]!, match[2]!);
    if (!media) parts.push({ type: "text", text: runtimeText("openai-audio.the_previous_session_s_media_reference_has_expired_provide") });
    else if (media.mimeType.startsWith("video/") && !allowedInput.includes("video")) parts.push({ type: "text", text: runtimeText("openai-audio.the_current_model_has_no_video_input_capability_configured") });
    else if (media.mimeType.startsWith("audio/") && !allowedInput.includes("audio")) parts.push({ type: "text", text: runtimeText("openai-audio.the_current_model_has_no_audio_input_capability_configured") });
    else if (!await stat(media.path).then((info) => info.isFile()).catch(() => false)) {
      parts.push({ type: "text", text: runtimeText("openai-audio.the_media_file_was_cleaned_up_or_is_missing") });
    } else {
      const part = media.mimeType.startsWith("video/") ? await videoPart(media.path, media.mimeType) : await audioPart(media.path, media.mimeType, signal);
      nativeParts.push(part);
      parts.push(part);
    }
    offset = match.index! + match[0].length;
  }
  if (offset < value.length) parts.push({ type: "text", text: value.slice(offset) });
  return { parts, media: nativeParts };
}

/** Translate Pi's transport-neutral audio references to the Chat Completions input_audio format. */
export async function prepareOpenAICompletionsPayload(payload: unknown, allowedInput: readonly string[], signal?: AbortSignal): Promise<CompletionPayload> {
  const source = payload as CompletionPayload;
  if (!Array.isArray(source.messages)) return source;
  const messages: CompletionMessage[] = [];
  let toolMedia: MediaPart[] = [];
  const flushToolMedia = () => {
    if (!toolMedia.length) return;
    messages.push({ role: "user", content: [{ type: "text", text: "Media from the preceding tool result:" }, ...toolMedia] });
    toolMedia = [];
  };
  for (const message of source.messages) {
    if (message.role !== "tool") flushToolMedia();
    const content = message.content;
    if (typeof content === "string" && (message.role === "user" || message.role === "tool")) {
      const converted = await textParts(content, allowedInput, signal);
      if (!converted.media.length && converted.parts.length === 1 && converted.parts[0]?.text === content) {
        messages.push(message);
      } else if (message.role === "tool") {
        toolMedia.push(...converted.media);
        messages.push({ ...message, content: converted.parts.filter((part) => part.type === "text").map((part) => part.text).join("") || runtimeText("openai-audio.audio_is_attached_to_a_subsequent_message") });
      } else if (message.role === "user") {
        messages.push({ ...message, content: converted.parts });
      } else messages.push(message);
      continue;
    }
    if (message.role !== "user" || !Array.isArray(content)) {
      messages.push(message);
      continue;
    }
    const next: CompletionPart[] = [];
    for (const part of content) {
      if (part.type === "text" && typeof part.text === "string") {
        const converted = await textParts(part.text, allowedInput, signal);
        next.push(...converted.parts);
      } else if (part.type === "image_url") {
        const url = (part.image_url as { url?: unknown } | undefined)?.url;
        const match = typeof url === "string" ? /^data:((?:audio|video)\/[^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(url) : null;
        if (!match) next.push(part);
        else if (match[1]!.startsWith("video/") && !allowedInput.includes("video")) next.push({ type: "text", text: runtimeText("openai-audio.the_current_model_has_no_video_input_capability_configured") });
        else if (match[1]!.startsWith("audio/") && !allowedInput.includes("audio")) next.push({ type: "text", text: runtimeText("openai-audio.the_current_model_has_no_audio_input_capability_configured") });
        else next.push(match[1]!.startsWith("video/")
          ? await videoPart(Buffer.from(match[2]!, "base64"), match[1]!)
          : await audioPart(Buffer.from(match[2]!, "base64"), match[1]!, signal));
      } else next.push(part);
    }
    messages.push({ ...message, content: next });
  }
  flushToolMedia();
  return { ...source, messages };
}

export function openAICompletionsStreamSimple(
  model: Model<any>, context: TranscriptContext, options?: SimpleStreamOptions, allowedInput: readonly string[] = [],
): AssistantMessageEventStream {
  const onPayload = options?.onPayload;
  return streamOpenAICompletions(model as never, context, {
    ...options,
    onPayload: async (payload, requestModel) => {
      const rewritten = await prepareOpenAICompletionsPayload(payload, allowedInput, options?.signal);
      return onPayload ? (await onPayload(rewritten, requestModel)) ?? rewritten : rewritten;
    },
  });
}
