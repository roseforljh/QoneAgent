import type { FileMessagePart } from "@assistant-ui/react";
import { filePreviewKind, type FilePreviewInfo } from "@qone/protocol";

export const QONE_FILE_PROVIDER = "qone";
export type InlineFileSource = Pick<FileMessagePart, "data" | "mimeType" | "sourceType">;
export type FileDataKind = "data-uri" | "url" | "base64" | "id";

export function getFileDataKind(data: string, sourceType?: "url" | "id"): FileDataKind {
  if (sourceType === "url" && /^data:/i.test(data)) return "data-uri";
  if (sourceType) return sourceType;
  if (/^data:/i.test(data)) return "data-uri";
  if (/^https?:\/\//i.test(data)) return "url";
  return "base64";
}

export function inlineFilePreviewable(source: InlineFileSource): boolean {
  if (!source.data) return false;
  const kind = getFileDataKind(source.data, source.sourceType);
  return kind !== "id" && (kind !== "url" || /^(https?:\/\/|blob:)/i.test(source.data));
}

export async function fileToDataUrl(file: Blob, mimeType = file.type || "application/octet-stream"): Promise<string> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return `data:${mimeType};base64,${btoa(binary)}`;
}

/** Decode the selected attachment itself; its display name is never a disk path. */
export async function readInlineFilePreview(name: string, source: InlineFileSource, signal?: AbortSignal): Promise<{ file: FilePreviewInfo; blob: Blob }> {
  if (!inlineFilePreviewable(source)) throw new Error("Unsupported attachment source");
  const kind = getFileDataKind(source.data, source.sourceType);
  const url = kind === "base64" ? `data:${source.mimeType};base64,${source.data}` : source.data;
  const response = await fetch(url, { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const blob = await response.blob();
  const mimeType = source.mimeType || blob.type || "application/octet-stream";
  let content: string | undefined;
  if (filePreviewKind(name, mimeType, true) === "binary") {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const encoding = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : "utf-8";
    try {
      const text = new TextDecoder(encoding, { fatal: true }).decode(bytes);
      if (!/[\u0000-\u0008\u000b\u000e-\u001f]/.test(text)) content = text;
    } catch { /* Binary attachments use the existing unsupported viewer. */ }
  }
  return { blob, file: { absolutePath: name, kind: filePreviewKind(name, mimeType, content === undefined), mimeType, content, size: blob.size, truncated: false } };
}

export function localPathFromFileMetadata(metadata?: FileMessagePart["providerMetadata"]): string | undefined {
  const value = metadata?.[QONE_FILE_PROVIDER];
  if (!value || typeof value !== "object") return undefined;
  const path = value.localPath;
  return typeof path === "string" && path.length > 0 ? path : undefined;
}
