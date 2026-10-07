import { readFile, stat } from "node:fs/promises";
import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { runtimeText } from "./runtime-localization.js";
import { MEDIA_MARKER, verifiedLocalMedia } from "./google-media.js";

type AnthropicPayload = { messages?: unknown[]; [key: string]: unknown };

async function nativeDocument(encoded: string, signature: string, allowedInput: readonly string[]): Promise<Record<string, unknown> | undefined> {
  const media = verifiedLocalMedia(encoded, signature);
  if (!media || !await stat(media.path).then((value) => value.isFile()).catch(() => false)) return undefined;
  const capability = media.mimeType.startsWith("video/") ? "video" : "audio";
  if (!allowedInput.includes(capability)) return undefined;
  return {
    type: "document",
    source: { type: "base64", media_type: media.mimeType, data: (await readFile(media.path)).toString("base64") },
  };
}

async function contentBlocks(value: string, allowedInput: readonly string[]): Promise<unknown[]> {
  const blocks: unknown[] = [];
  let offset = 0;
  for (const match of value.matchAll(MEDIA_MARKER)) {
    if (match.index! > offset) blocks.push({ type: "text", text: value.slice(offset, match.index) });
    blocks.push(await nativeDocument(match[1]!, match[2]!, allowedInput)
      ?? { type: "text", text: runtimeText("openai-audio.media_file_was_unavailable_for_native_input") });
    offset = match.index! + match[0].length;
  }
  if (offset < value.length) blocks.push({ type: "text", text: value.slice(offset) });
  return blocks;
}

export async function prepareAnthropicPayload(payload: unknown, allowedInput: readonly string[]): Promise<AnthropicPayload> {
  const source = payload as AnthropicPayload;
  if (!Array.isArray(source.messages)) return source;
  const messages = [] as unknown[];
  for (const raw of source.messages) {
    if (!raw || typeof raw !== "object") {
      messages.push(raw);
      continue;
    }
    const message = raw as Record<string, unknown>;
    if (typeof message.content === "string" && MEDIA_MARKER.test(message.content)) {
      MEDIA_MARKER.lastIndex = 0;
      messages.push({ ...message, content: await contentBlocks(message.content, allowedInput) });
    } else if (Array.isArray(message.content)) {
      const content: unknown[] = [];
      for (const rawBlock of message.content) {
        if (rawBlock && typeof rawBlock === "object" && (rawBlock as Record<string, unknown>).type === "text" && typeof (rawBlock as Record<string, unknown>).text === "string") {
          const text = (rawBlock as Record<string, unknown>).text as string;
          if (MEDIA_MARKER.test(text)) {
            MEDIA_MARKER.lastIndex = 0;
            content.push(...await contentBlocks(text, allowedInput));
          } else content.push(rawBlock);
        } else content.push(rawBlock);
      }
      messages.push({ ...message, content });
    } else messages.push(message);
  }
  return { ...source, messages };
}

export function anthropicMediaStreamSimple(model: Model<any>, context: TranscriptContext, options: SimpleStreamOptions | undefined, allowedInput: readonly string[]): AssistantMessageEventStream {
  const onPayload = options?.onPayload;
  return streamAnthropic(model as never, context, {
    ...options,
    onPayload: async (payload, requestModel) => {
      const rewritten = await prepareAnthropicPayload(payload, allowedInput);
      return onPayload ? (await onPayload(rewritten, requestModel)) ?? rewritten : rewritten;
    },
  });
}
