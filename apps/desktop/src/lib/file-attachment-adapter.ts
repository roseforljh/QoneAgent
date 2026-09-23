import type {
  Attachment,
  AttachmentAdapter,
  CompleteAttachment,
  PendingAttachment,
} from "@assistant-ui/react";

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
    return {
      id: createAttachmentId(),
      type: "file",
      name: file.name,
      contentType: file.type || "application/octet-stream",
      file,
      status: { type: "requires-action", reason: "composer-send" },
    };
  }

  public async send(attachment: PendingAttachment): Promise<CompleteAttachment> {
    const mimeType = attachment.contentType || "application/octet-stream";
    return {
      ...attachment,
      status: { type: "complete" },
      content: [{
        type: "file",
        filename: attachment.name,
        mimeType,
        data: await readFileDataUrl(attachment.file),
      }],
    };
  }

  public async remove(_attachment: Attachment): Promise<void> {
    // Local files do not need an upload cleanup request.
  }
}
