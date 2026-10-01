import { runtimeText, runtimeError } from "./runtime-localization";
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
    ? runtimeText("pi-attachments.delegate_original_attachments_without_preprocessing_if_the_executing_agent", { p0: lines.join("\n") })
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
      throw runtimeError("pi-attachments.could_not_read_local_attachment", { p0: attachment.localPath }, { cause: error });
    }
  }));
}

export function promptWithAttachments(message: string, attachments: readonly (MessageAttachmentInfo & { temporary?: boolean })[] = [], nativeMedia: boolean | "audio" = false, allowedInput?: readonly MediaCapability[]): string {
  const escapeName = (name: string) => name.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const files = attachments.flatMap((attachment) => {
    if (attachment.type === "folder") return attachment.localPath
      ? [`<attachment type="folder" name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`]
      : [runtimeText("pi-attachments.folder_attachment_no_readable_local_path_attach_it_again", { p0: escapeName(attachment.name) })];
    if (attachment.type === "image" || attachment.mimeType.startsWith("image/")) return [
      ...(attachment.localPath ? [`<attachment name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`] : []),
      ...(allowedInput && !canReadAttachment(allowedInput, attachment)
        ? [runtimeText("pi-attachments.image_attachment_the_current_model_has_no_image_input", { p0: escapeName(attachment.name) })] : []),
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
        ? runtimeText("pi-attachments.the_current_api_format_has_no_direct_video_file")
        : canExtractAudio
          ? runtimeText("pi-attachments.the_current_model_can_call_qone_media_extract_audio")
          : runtimeText("pi-attachments.the_current_model_cannot_read_this_media_directly_delegate");
      return [
        ...(attachment.localPath ? [`<attachment name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`] : []),
        runtimeText("pi-attachments.media_attachment", { p0: escapeName(attachment.name), p1: escapeName(attachment.mimeType), p2: action }),
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
      return [runtimeText("pi-attachments.attachment_no_readable_local_path_attach_it_again_from", { p0: escapeName(attachment.name) })];
    }
    return [`<attachment name="${escapeName(attachment.name)}" path="${escapeName(attachment.localPath)}" />`];
  });
  return [message.trim(), ...files].filter(Boolean).join("\n\n") || runtimeText("pi-attachments.please_analyze_the_attachment");
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


