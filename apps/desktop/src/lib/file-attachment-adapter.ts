import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";
import { CompositeAttachmentAdapter, SimpleImageAttachmentAdapter, SimpleTextAttachmentAdapter } from "@assistant-ui/react";
import type { NativeAttachmentFile } from "./native-attachment-file";
import { INLINE_ATTACHMENT_LIMIT_BYTES, isAudioVideo } from "./native-attachment-file";

const createAttachmentId = () => {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `attachment-${Date.now()}-${Math.random().toString(36).slice(2)}`;
};

const readFileDataUrl = (file: File): Promise<string> => {
  if (typeof FileReader === "undefined") {
    return file.arrayBuffer().then((buffer) => {
      const bytes = new Uint8Array(buffer);
      let binary = "";
      for (let index = 0; index < bytes.length; index += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
      }
      return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
    });
  }

  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error(`无法读取附件：${file.name}`));
    reader.readAsDataURL(file);
  });
};

/** Handles file types that are outside the built-in image and text adapters. */
export class AnyFileAttachmentAdapter implements AttachmentAdapter {
  public readonly accept = "*";

  public async add({ file }: { file: File }): Promise<PendingAttachment> {
    const nativeFile = file as NativeAttachmentFile;
    return {
      id: createAttachmentId(),
      type: nativeFile.qoneLocalPath && /^image\/(?:png|jpeg|webp|gif)$/i.test(file.type) ? "image" : "file",
      name: file.name,
      contentType: file.type || "application/octet-stream",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  public async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const mimeType = attachment.contentType || "application/octet-stream";
    const nativeFile = attachment.file as NativeAttachmentFile;
    if (!nativeFile.qoneLocalPath && !isAudioVideo(mimeType) && nativeFile.size > INLINE_ATTACHMENT_LIMIT_BYTES) {
      throw new Error("超过 50 MB 的文件请通过附件菜单选择本地文件");
    }
    return {
      ...attachment,
      status: { type: "complete" },
      content: attachment.type === "image" && nativeFile.qoneLocalPath
        ? [{ type: "image", image: "", filename: attachment.name }]
        : [{ type: "file", filename: attachment.name, mimeType, data: nativeFile.qoneLocalPath ? "" : await readFileDataUrl(attachment.file) }],
    };
  }

  public async remove(_attachment: Attachment): Promise<void> {
    // Local files do not need an upload cleanup request.
  }
}

/** Native selections carry an OS path; browser and clipboard Files use the library adapters. */
export class QoneAttachmentAdapter implements AttachmentAdapter {
  public readonly accept = "*";
  private readonly native = new AnyFileAttachmentAdapter();
  private readonly browser = new CompositeAttachmentAdapter([
    new SimpleTextAttachmentAdapter(),
    new SimpleImageAttachmentAdapter(),
    new AnyFileAttachmentAdapter(),
  ]);

  public add(state: { file: File }) {
    return (state.file as NativeAttachmentFile).qoneLocalPath ? this.native.add(state) : this.browser.add(state);
  }

  public send(attachment: PendingAttachment) {
    return (attachment.file as NativeAttachmentFile).qoneLocalPath ? this.native.send(attachment) : this.browser.send(attachment);
  }

  public remove(attachment: Attachment) {
    return (attachment.file as NativeAttachmentFile | undefined)?.qoneLocalPath ? this.native.remove(attachment) : this.browser.remove(attachment);
  }
}
