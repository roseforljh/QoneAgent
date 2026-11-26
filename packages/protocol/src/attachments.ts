import { z } from "zod";

export const DIRECTORY_MIME_TYPE = "inode/directory";

/** 聊天与团队模式共用的附件协议校验（图片、文件与本地文件夹引用）。 */
export const messageAttachmentSchema = z.object({
  type: z.enum(["image", "file", "folder"]),
  name: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(128),
  data: z.string(),
  localPath: z.string().min(1).max(4096).optional(),
}).refine((attachment) => attachment.type === "folder"
  ? attachment.mimeType === DIRECTORY_MIME_TYPE && Boolean(attachment.localPath) && attachment.data === ""
  : attachment.localPath
  ? attachment.data === "" && (attachment.type !== "image" || /^image\/(png|jpeg|webp|gif)$/i.test(attachment.mimeType))
  : (/^(?:audio|video)\//i.test(attachment.mimeType) || attachment.data.length <= 70_000_000) &&
    /^data:[^,]*;base64,[A-Za-z0-9+/=]+$/i.test(attachment.data) &&
    attachment.data.toLowerCase().startsWith(`data:${attachment.mimeType.toLowerCase()}`) &&
    (attachment.type !== "image" || /^image\/(png|jpeg|webp|gif)$/i.test(attachment.mimeType)));

export const nonMediaAttachmentBytes = (attachments: readonly { data: string; mimeType: string }[] | undefined) =>
  attachments?.reduce((total, attachment) => total + (/^(?:audio|video)\//i.test(attachment.mimeType) ? 0 : attachment.data.length), 0) ?? 0;
