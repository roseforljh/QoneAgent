import type { AppendMessage } from "@assistant-ui/react";
import type { MessageAttachmentInfo } from "@qone/protocol";
import { GEMINI_FILE_LIMIT_BYTES, INLINE_ATTACHMENT_LIMIT_BYTES, isGeminiMedia, type NativeAttachmentFile } from "./native-attachment-file";

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
    reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
    reader.readAsDataURL(file);
  });
}

export async function serializeMessageAttachments(message: AppendMessage): Promise<MessageAttachmentInfo[]> {
  const input = message.attachments ?? [];
  if (input.length > 8) throw new Error("一次最多发送 8 个附件");
  const attachments = await Promise.all(input.map(async (attachment) => {
    const type: MessageAttachmentInfo["type"] = attachment.type === "image" ? "image" : "file";
    const mimeType = attachment.contentType || attachment.file?.type || (type === "image" ? "image/png" : "text/plain");
    const nativeFile = attachment.file as NativeAttachmentFile | undefined;
    if (nativeFile?.qoneLocalPath) {
      if (!isGeminiMedia(mimeType)) throw new Error(`大型附件仅支持 Gemini 音频或视频：${attachment.name}`);
      if ((nativeFile.qoneFileSize ?? 0) > GEMINI_FILE_LIMIT_BYTES) throw new Error(`Gemini Files API 单文件不能超过 2 GB：${attachment.name}`);
      return { type: "file", name: attachment.name, mimeType, data: "", localPath: nativeFile.qoneLocalPath } satisfies MessageAttachmentInfo;
    }
    if (nativeFile && nativeFile.size > INLINE_ATTACHMENT_LIMIT_BYTES) throw new Error("超过 50 MB 的音视频请通过附件菜单选择本地文件");
    const data = type === "image"
      ? attachment.content.find((part) => part.type === "image")?.image
      : attachment.file ? await readDataUrl(attachment.file) : undefined;
    if (!data) throw new Error(`附件无法读取：${attachment.name}`);
    if (data.length > MAX_DATA_LENGTH) throw new Error(`附件过大：${attachment.name}`);
    if (type === "image" && !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/=]+$/i.test(data)) {
      throw new Error(`不支持的图片格式：${attachment.name}`);
    }
    const serialized: MessageAttachmentInfo = { type, name: attachment.name, mimeType, data };
    return serialized;
  }));
  if (attachments.reduce((total, attachment) => total + attachment.data.length, 0) > MAX_TOTAL_DATA_LENGTH) {
    throw new Error("附件总大小不能超过 100 MB");
  }
  return attachments;
}
