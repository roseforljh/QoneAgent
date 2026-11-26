export type FilePreviewKind = "markdown" | "html" | "text" | "image" | "pdf" | "audio" | "video" | "word" | "spreadsheet" | "binary";

const SPREADSHEET_MIME_TYPES = new Set([
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  "application/vnd.ms-excel",
  "application/vnd.oasis.opendocument.spreadsheet",
]);

export interface FilePreviewInfo {
  absolutePath: string;
  kind: FilePreviewKind;
  mimeType: string;
  size: number;
  content?: string;
  truncated: boolean;
}

/** MIME and the real filename determine the viewer, never the link's label. */
export function filePreviewKind(path: string, mimeType: string, binary: boolean): FilePreviewKind {
  const mime = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (mime.startsWith("image/")) return "image";
  if (mime === "application/pdf") return "pdf";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") return "word";
  if (SPREADSHEET_MIME_TYPES.has(mime)) return "spreadsheet";
  if (binary) return "binary";
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase();
  if (mime === "text/markdown" || ["md", "markdown", "mdown", "mdx"].includes(extension ?? "")) return "markdown";
  if (mime === "text/html" || extension === "html" || extension === "htm") return "html";
  return "text";
}
