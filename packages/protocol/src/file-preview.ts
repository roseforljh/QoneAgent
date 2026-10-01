export type FilePreviewKind = "markdown" | "html" | "text" | "image" | "pdf" | "audio" | "video" | "binary";

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
  if (binary) return "binary";
  const extension = /\.([^.\\/]+)$/.exec(path)?.[1]?.toLowerCase();
  if (mime === "text/markdown" || ["md", "markdown", "mdown", "mdx"].includes(extension ?? "")) return "markdown";
  if (mime === "text/html" || extension === "html" || extension === "htm") return "html";
  return "text";
}
