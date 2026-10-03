import { translateCurrent as t } from "../localization";
import type { AppendMessage } from "@assistant-ui/react";
import type { MessageAttachmentInfo } from "@qone/protocol";
import { INLINE_ATTACHMENT_LIMIT_BYTES, isAudioVideo, type NativeAttachmentFile } from "./native-attachment-file";
import { localAttachmentTypeFromMetadata, localPathFromFileMetadata } from "./message-file-preview";

const MAX_DATA_LENGTH = 70_000_000;
const MAX_TOTAL_DATA_LENGTH = 140_000_000;

function readDataUrl(file: File): Promise<string> {
  if (typeof FileReader === "undefined") return file.arrayBuffer().then((buffer) => {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
  });
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(t("attachment.readFailed", { name: file.name })));
    reader.readAsDataURL(file);
  });
}

export async function serializeMessageAttachments(message: AppendMessage): Promise<MessageAttachmentInfo[]> {
  const input = message.attachments ?? [];
  const attachments = await Promise.all(input.map(async (attachment) => {
    const nativeFile = attachment.file as NativeAttachmentFile | undefined;
    const metadataPart = attachment.content.find((part) => part.type === "file" || part.type === "image");
    const localPath = nativeFile?.qoneLocalPath ?? localPathFromFileMetadata(metadataPart?.providerMetadata);
    const type: MessageAttachmentInfo["type"] = nativeFile?.qoneIsDirectory
      ? "folder"
      : localAttachmentTypeFromMetadata(metadataPart?.providerMetadata) ?? (attachment.type === "image" ? "image" : "file");
    const mimeType = attachment.contentType || attachment.file?.type || (type === "image" ? "image/png" : "text/plain");
    if (localPath) return { type, name: attachment.name, mimeType, data: "", localPath } satisfies MessageAttachmentInfo;
    if (nativeFile && !isAudioVideo(mimeType) && nativeFile.size > INLINE_ATTACHMENT_LIMIT_BYTES) throw new Error(t("attachment.useLocalFile"));
    const data = type === "image"
      ? attachment.content.find((part) => part.type === "image")?.image
      : attachment.file ? await readDataUrl(attachment.file)
        : attachment.content.find((part) => part.type === "file")?.data;
    if (!data) throw new Error(t("attachment.readFailed", { name: attachment.name }));
    if (!isAudioVideo(mimeType) && data.length > MAX_DATA_LENGTH) throw new Error(t("attachment.tooLarge", { name: attachment.name }));
    if (type === "image" && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(data)) {
      throw new Error(t("attachment.unsupportedImage", { name: attachment.name }));
    }
    const serialized: MessageAttachmentInfo = { type, name: attachment.name, mimeType, data };
    return serialized;
  }));
  if (attachments.reduce((total, attachment) => total + (isAudioVideo(attachment.mimeType) ? 0 : attachment.data.length), 0) > MAX_TOTAL_DATA_LENGTH) {
    throw new Error(t("attachment.totalTooLarge"));
  }
  return attachments;
}
