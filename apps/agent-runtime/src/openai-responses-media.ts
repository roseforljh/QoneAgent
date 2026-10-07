import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import type { AssistantMessageEventStream, Model, SimpleStreamOptions, TranscriptContext } from "@earendil-works/pi-ai";
import { streamSimple as streamOpenAIResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamCodexResponses } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { runtimeText } from "./runtime-localization.js";
import { MEDIA_MARKER, verifiedLocalMedia } from "./google-media.js";

type ResponsesPayload = { input?: unknown; [key: string]: unknown };

async function nativeFileBlock(encoded: string, signature: string, allowedInput: readonly string[]): Promise<Record<string, unknown> | undefined> {
  const media = verifiedLocalMedia(encoded, signature);
  if (!media || !await stat(media.path).then((value) => value.isFile()).catch(() => false)) return undefined;
  const capability = media.mimeType.startsWith("video/") ? "video" : "audio";
  if (!allowedInput.includes(capability)) return undefined;
  const data = (await readFile(media.path)).toString("base64");
  return {
    type: "input_file",
    filename: path.basename(media.path),
    file_data: `data:${media.mimeType};base64,${data}`,
  };
}

async function responseParts(value: string, allowedInput: readonly string[]): Promise<unknown[]> {
  const parts: unknown[] = [];
  let offset = 0;
  for (const match of value.matchAll(MEDIA_MARKER)) {
    if (match.index! > offset) parts.push({ type: "input_text", text: value.slice(offset, match.index) });
    const media = await nativeFileBlock(match[1]!, match[2]!, allowedInput);
    parts.push(media ?? { type: "input_text", text: runtimeText("openai-audio.media_file_was_unavailable_for_native_input") });
    offset = match.index! + match[0].length;
  }
  if (offset < value.length) parts.push({ type: "input_text", text: value.slice(offset) });
  return parts;
}

export async function prepareOpenAIResponsesPayload(payload: unknown, allowedInput: readonly string[]): Promise<ResponsesPayload> {
  const source = payload as ResponsesPayload;
  if (!Array.isArray(source.input)) return source;
  const input = [] as unknown[];
  for (const raw of source.input) {
    if (!raw || typeof raw !== "object") {
      input.push(raw);
      continue;
    }
    const item = raw as Record<string, unknown>;
    if (Array.isArray(item.content)) {
      const content: unknown[] = [];
      for (const part of item.content) {
        if (part && typeof part === "object" && (part as Record<string, unknown>).type === "input_text" && typeof (part as Record<string, unknown>).text === "string") {
          const text = (part as Record<string, unknown>).text as string;
          if (MEDIA_MARKER.test(text)) {
            MEDIA_MARKER.lastIndex = 0;
            content.push(...await responseParts(text, allowedInput));
          } else content.push(part);
        } else content.push(part);
      }
      input.push({ ...item, content });
    } else if (typeof item.output === "string" && MEDIA_MARKER.test(item.output)) {
      MEDIA_MARKER.lastIndex = 0;
      input.push({ ...item, output: await responseParts(item.output, allowedInput) });
    } else input.push(item);
  }
  return { ...source, input };
}

function wrap(
  stream: typeof streamOpenAIResponses,
  model: Model<any>,
  context: TranscriptContext,
  options: SimpleStreamOptions | undefined,
  allowedInput: readonly string[],
): AssistantMessageEventStream {
  const onPayload = options?.onPayload;
  return stream(model as never, context, {
    ...options,
    onPayload: async (payload, requestModel) => {
      const rewritten = await prepareOpenAIResponsesPayload(payload, allowedInput);
      return onPayload ? (await onPayload(rewritten, requestModel)) ?? rewritten : rewritten;
    },
  });
}

export function openAIResponsesMediaStreamSimple(model: Model<any>, context: TranscriptContext, options: SimpleStreamOptions | undefined, allowedInput: readonly string[]): AssistantMessageEventStream {
  return wrap(streamOpenAIResponses, model, context, options, allowedInput);
}

export function codexResponsesMediaStreamSimple(model: Model<any>, context: TranscriptContext, options: SimpleStreamOptions | undefined, allowedInput: readonly string[]): AssistantMessageEventStream {
  return wrap(streamCodexResponses as unknown as typeof streamOpenAIResponses, model, context, options, allowedInput);
}
