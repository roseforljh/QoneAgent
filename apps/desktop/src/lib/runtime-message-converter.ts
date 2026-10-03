import type { ThreadMessageLike } from "@assistant-ui/react";
import type { ChatMessage, ToolCall } from "../store";
import { assistantMessageContent } from "./assistant-message-parts";
import { appendSubagentImages, type subagentImagesByRun } from "./subagent-images";
import { QONE_FILE_PROVIDER } from "./message-file-preview";

export interface MessageConversionContext {
  imagePreviews: Readonly<Record<string, string>>;
  toolCallsByRun: ReadonlyMap<string, readonly ToolCall[]>;
  imageWindows: ReadonlyMap<string, { after?: number; through?: number }>;
  childImagesByRun: ReturnType<typeof subagentImagesByRun>;
  running: boolean;
  imageModel: boolean;
  imageGenerationError?: { content: string };
  chatRunErrorDetail?: string;
}

// assistant-ui also caches by input identity. Preconvert with explicit local
// dependencies, so affected messages get new identities without flushing history.
export function createMessageConverter() {
  const cache = new WeakMap<ChatMessage, { dependencies: unknown[]; message: ThreadMessageLike }>();
  return (message: ChatMessage, context: MessageConversionContext): ThreadMessageLike => {
    const role = message.role === "assistant" ? "assistant" : "user";
    const streaming = role === "assistant" && message.id === "streaming";
    const calls = role === "assistant" && !message.parts && message.runId
      ? context.toolCallsByRun.get(message.runId) ?? [] : [];
    const window = context.imageWindows.get(message.id);
    const images = role === "assistant" && message.runId
      ? context.childImagesByRun.get(message.runId)?.filter((image) =>
        (window?.after === undefined || image.startedAt > window.after)
        && (window?.through === undefined || image.startedAt <= window.through)) ?? [] : [];
    const failure = role === "assistant" && message.id.startsWith("image-error:")
      ? context.imageGenerationError : undefined;
    const dependencies: unknown[] = role === "user"
      ? (message.attachments ?? []).flatMap((attachment) => attachment.type === "image" && attachment.localPath
        ? [context.imagePreviews[attachment.localPath]] : [])
      : [streaming && context.running, streaming && context.imageModel,
        failure?.content, failure ? context.chatRunErrorDetail : undefined,
        calls.length, ...calls,
        ...images.flatMap((image) => [image.image, image.filename, image.startedAt])];
    const cached = cache.get(message);
    if (cached && cached.dependencies.length === dependencies.length
      && dependencies.every((value, index) => Object.is(value, cached.dependencies[index]))) return cached.message;

    const createdAt = cached?.message.createdAt ?? new Date(message.createdAt ?? Date.now());
    let converted: ThreadMessageLike;
    if (role === "user") {
      converted = {
        id: message.id, role, createdAt,
        content: [
          ...(message.content ? [{ type: "text" as const, text: message.content }] : []),
          ...(message.attachments ?? []).map((attachment) => {
            const image = attachment.localPath ? context.imagePreviews[attachment.localPath] : attachment.data;
            return attachment.type === "image" && image
              ? { type: "image" as const, image, filename: attachment.name }
              : {
                type: "file" as const,
                filename: attachment.name,
                mimeType: attachment.mimeType,
                data: attachment.data,
                providerMetadata: attachment.localPath
                  ? { [QONE_FILE_PROVIDER]: { localPath: attachment.localPath } }
                  : undefined,
              };
          }),
        ],
      };
    } else {
      const content = appendSubagentImages(assistantMessageContent(message, calls, streaming), images);
      const generating = streaming && context.running && context.imageModel && content.length === 0;
      converted = {
        id: message.id, role, createdAt, content,
        metadata: generating || failure ? { custom: { qoneImageGeneration: generating
          ? { prompt: message.content, generating: true }
          : { prompt: failure!.content, error: context.chatRunErrorDetail } } } : undefined,
        status: streaming && context.running ? { type: "running" } : { type: "complete", reason: "stop" },
      };
    }
    cache.set(message, { dependencies, message: converted });
    return converted;
  };
}

export const convertedMessage = (message: ThreadMessageLike): ThreadMessageLike => message;
