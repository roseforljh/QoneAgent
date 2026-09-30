import type { FileEntry } from "@earendil-works/pi-coding-agent";
import type { ImageContent } from "@earendil-works/pi-ai";
import { readFile } from "node:fs/promises";
import { parseMcpCommand, type MessageAttachmentInfo } from "@qone/protocol";
import { googleMediaContent, localMediaMarker } from "./google-media.js";
import { canReadAttachment, type MediaCapability } from "./media-capabilities.js";

export interface PersistedPiMessage {
  role: string;
  content: string;
  attachments?: MessageAttachmentInfo[];
  createdAt: number;
  rawMessage?: unknown;
}

export function videoAttachmentNotice(attachments: readonly MessageAttachmentInfo[] | undefined, refs: Map<string, MessageAttachmentInfo>): string {
  if (!attachments?.length) return "";
  const escape = (value: string) => value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const lines = attachments.flatMap((attachment) => {
    if (!attachment.mimeType.startsWith("video/")) return [];
    const id = crypto.randomUUID();
    refs.set(id, attachment);
    return [`<video id="${id}" name="${escape(attachment.name)}" />`];
  });
  return lines.length
    ? `<runtime-video-attachments>\n${lines.join("\n")}\n需要委派时直接传原始附件，勿提前处理。最终执行代理若使用非 Gemini API 格式且配置了视频和图像输入，先用 qone_media_extract_frames 读取时长，再传 timestamps 按需读取静态画面；只需声音且配置了音频输入时，可调用 qone_media_extract_audio。两者都传 attachmentId。\n</runtime-video-attachments>`
    : "";
}

function isPiTranscriptMessage(value: unknown): value is { role: string; [key: string]: unknown } {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" && [
    "user", "assistant", "toolResult", "bashExecution", "custom",
    "branchSummary", "compactionSummary",
  ].includes(role);
}

export function imageContent(attachments: readonly MessageAttachmentInfo[] = [], allowedInput?: readonly MediaCapability[]): ImageContent[] {
  return attachments.flatMap((attachment) => {
    if (attachment.type === "folder") return [];
    if (!(attachment.type === "image" || attachment.mimeType.startsWith("image/")) || (allowedInput && !allowedInput.includes("image"))) return [];
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data);
    return match ? [{ type: "image" as const, data: match[2]!, mimeType: match[1]!.toLowerCase() }] : [];
  });
}

/** Read local images only when a model request needs their bytes. Persisted attachments keep paths. */
export async function materializeModelInputs(
  attachments: readonly MessageAttachmentInfo[] | undefined,
  google: boolean,
  allowedInput?: readonly MediaCapability[],
  skipUnavailable = false,
): Promise<MessageAttachmentInfo[] | undefined> {
  if (!attachments) return undefined;
  return Promise.all(attachments.map(async (attachment) => {
    if (attachment.type === "folder") return attachment;
    if (!attachment.localPath || attachment.data) return attachment;
    const image = /^image\/(?:png|jpeg|webp|gif)$/i.test(attachment.mimeType)
      && (!allowedInput || allowedInput.includes("image"));
    if (!image && !(google && attachment.mimeType === "application/pdf")) return attachment;
    try {
      const bytes = await readFile(attachment.localPath);
      return { ...attachment, data: `data:${attachment.mimeType};base64,${bytes.toString("base64")}` };
    } catch (error) {
      if (skipUnavailable) return attachment;
      throw new Error(`无法读取本地附件：${attachment.localPath}`, { cause: error });
    }
  }));
}

export function promptWithAttachments(message: string, attachments: readonly (MessageAttachmentInfo & { temporary?: boolean })[] = [], nativeMedia: boolean | "audio" = false, allowedInput?: readonly MediaCapability[]): string {
  const escapeName = (name: string) => name.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const files = attachments.flatMap((attachment) => {
    if (attachment.type === "folder") return attachment.localPath
      ? [`<attachment type="folder" name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`]
      : [`[文件夹附件 ${escapeName(attachment.name)}：没有可读取的本地路径，请重新附加]`];
    if (attachment.type === "image" || attachment.mimeType.startsWith("image/")) return [
      ...(attachment.localPath ? [`<attachment name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`] : []),
      ...(allowedInput && !canReadAttachment(allowedInput, attachment)
        ? [`[图片附件 ${escapeName(attachment.name)}：当前模型未配置图像输入能力，需交给能处理图片的子代理]`] : []),
    ];
    if (attachment.type !== "file") return [];
    const canUseNativeMedia = nativeMedia && /^(?:audio|video)\//i.test(attachment.mimeType)
      && (nativeMedia !== "audio" || attachment.mimeType.startsWith("audio/"))
      && (!allowedInput || canReadAttachment(allowedInput, attachment));
    if (canUseNativeMedia && attachment.localPath) return [localMediaMarker(attachment.localPath, attachment.mimeType, attachment.temporary === true)];
    if (canUseNativeMedia && /^(?:audio|video)\//i.test(attachment.mimeType)) return [];
    if (/^(?:audio|video)\//i.test(attachment.mimeType)) {
      const video = attachment.mimeType.startsWith("video/");
      const canReadFrames = video && nativeMedia !== true && allowedInput?.includes("video") && allowedInput.includes("image");
      const canExtractAudio = video && Boolean(nativeMedia) && allowedInput?.includes("audio");
      const action = canReadFrames
        ? "当前 API 格式没有直接的视频文件输入；需要画面时由最终执行代理按需读取画面帧"
        : canExtractAudio
          ? "当前模型可按需调用 qone_media_extract_audio 读取声音；若任务需要画面，请委派原始附件"
          : "当前模型无法直接读取，需交给能处理该媒体的子代理";
      return [
        ...(attachment.localPath ? [`<attachment name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`] : []),
        `[媒体附件 ${escapeName(attachment.name)}（${escapeName(attachment.mimeType)}）：${action}]`,
      ];
    }
    if (!attachment.localPath) {
      if (/^(?:text\/|application\/(?:json|xml)(?:$|;))/i.test(attachment.mimeType)) {
        const encoded = /^data:[^,]*;base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data)?.[1];
        if (encoded) {
          try {
            const content = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(encoded, "base64"));
            return [`<attachment name="${escapeName(attachment.name)}">\n${content}\n</attachment>`];
          } catch { /* Invalid text must not be inserted into the model context as replacement characters. */ }
        }
      }
      return [`[附件 ${escapeName(attachment.name)}：没有可读取的本地路径，如需使用文件工具读取请从本地重新附加]`];
    }
    return [`<attachment name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`];
  });
  return [message.trim(), ...files].filter(Boolean).join("\n\n") || "请分析附件。";
}

/**
 * Rebuild the Pi transcript from the product database. Pi's own session files
 * are deliberately not the product source of truth, so a runtime restart must
 * recreate the in-memory SessionManager from the SQLite messages.
 */
export function createPiSessionEntries(
  cwd: string,
  messages: PersistedPiMessage[],
  model?: { api: string; provider: string; id: string },
  allowedInput?: readonly MediaCapability[],
): FileEntry[] {
  const header: FileEntry = {
    type: "session",
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  };
  let parentId: string | null = null;
  const entries: FileEntry[] = [header];
  for (const message of messages) {
    if (isPiTranscriptMessage(message.rawMessage)) {
      const id = crypto.randomUUID();
      entries.push({ type: "message", id, parentId, timestamp: new Date(message.createdAt).toISOString(), message: message.rawMessage } as FileEntry);
      parentId = id;
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    // Assistant messages require provider metadata in Pi's transcript format.
    // When no model is configured yet, keep the user side of the conversation;
    // the first configured run will establish the assistant model metadata.
    if (message.role === "assistant" && !model) continue;
    const id = crypto.randomUUID();
    const base = { type: "message" as const, id, parentId, timestamp: new Date(message.createdAt).toISOString() };
    const isGoogle = model?.api === "google-generative-ai";
    const isCompletions = model?.api === "openai-completions";
    const images = isGoogle ? googleMediaContent(message.attachments, allowedInput)
      : [...imageContent(message.attachments, allowedInput), ...(isCompletions ? googleMediaContent(message.attachments?.filter((item) => item.mimeType.startsWith("audio/")), allowedInput) : [])];
    const prompt = promptWithAttachments(message.role === "user" ? parseMcpCommand(message.content)?.text ?? message.content : message.content, message.attachments, isGoogle ? true : isCompletions ? "audio" : false, allowedInput);
    const value = message.role === "user"
      ? { ...base, message: { role: "user" as const, content: images.length ? [
          { type: "text" as const, text: prompt },
          ...images,
        ] : prompt, timestamp: message.createdAt } }
      : {
          ...base,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: model!.api,
            provider: model!.provider,
            model: model!.id,
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: message.createdAt,
          },
        };
    entries.push(value as FileEntry);
    parentId = id;
  }
  return entries;
}


