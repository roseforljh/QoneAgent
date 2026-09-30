import { DIRECTORY_MIME_TYPE } from "@qone/protocol";
import archiveIcon from "../assets/codex-icons/document-zip-light-16.svg";
import audioIcon from "../assets/codex-icons/music-note-light-20.svg";
import codeIcon from "../assets/codex-icons/code-light-20.svg";
import documentIcon from "../assets/codex-icons/document-text-light-24.svg";
import fileIcon from "../assets/codex-icons/document-light-24.svg";
import folderIcon from "../assets/codex-icons/folder-light-20.svg";
import imageIcon from "../assets/codex-icons/photo-light-20.svg";
import pdfIcon from "../assets/codex-icons/document-pdf-light-20.svg";
import presentationIcon from "../assets/codex-icons/presentation-light-16.svg";
import spreadsheetIcon from "../assets/codex-icons/spreadsheet-light-16.svg";
import videoIcon from "../assets/codex-icons/video-light-20.svg";

export type AttachmentFileKind = "folder" | "image" | "pdf" | "spreadsheet" | "presentation" | "document" | "code" | "archive" | "audio" | "video" | "file";

const extensionKinds: Record<string, AttachmentFileKind> = {
  png: "image", jpg: "image", jpeg: "image", gif: "image", webp: "image", bmp: "image", svg: "image", heic: "image", avif: "image",
  mp3: "audio", wav: "audio", flac: "audio", m4a: "audio", aac: "audio", ogg: "audio", opus: "audio",
  mp4: "video", mov: "video", mkv: "video", avi: "video", webm: "video", flv: "video",
  pdf: "pdf",
  csv: "spreadsheet", tsv: "spreadsheet", xls: "spreadsheet", xlsm: "spreadsheet", xlsx: "spreadsheet", ods: "spreadsheet",
  ppt: "presentation", pptx: "presentation", odp: "presentation", key: "presentation",
  doc: "document", docx: "document", odt: "document", rtf: "document", txt: "document", md: "document", mdx: "document",
  zip: "archive", gz: "archive", tgz: "archive", tar: "archive", "7z": "archive", rar: "archive",
  js: "code", jsx: "code", ts: "code", tsx: "code", py: "code", rs: "code", go: "code", java: "code", cs: "code", cpp: "code", c: "code", h: "code", html: "code", css: "code", json: "code", jsonc: "code", yaml: "code", yml: "code", toml: "code", xml: "code", sh: "code", ps1: "code", sql: "code", ipynb: "code",
};

const iconByKind: Record<AttachmentFileKind, string> = {
  folder: folderIcon,
  image: imageIcon,
  pdf: pdfIcon,
  spreadsheet: spreadsheetIcon,
  presentation: presentationIcon,
  document: documentIcon,
  code: codeIcon,
  archive: archiveIcon,
  audio: audioIcon,
  video: videoIcon,
  file: fileIcon,
};

export function attachmentFileKind(name: string, mimeType: string): AttachmentFileKind {
  const mime = mimeType.split(";", 1)[0]!.trim().toLowerCase();
  if (mime === DIRECTORY_MIME_TYPE) return "folder";
  const basename = name.split(/[\\/]/).at(-1)?.toLowerCase() ?? "";
  const extension = basename.startsWith(".") && !basename.slice(1).includes(".")
    ? basename.slice(1)
    : basename.includes(".") ? basename.split(".").at(-1)! : basename;
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("audio/")) return "audio";
  if (mime.startsWith("video/")) return "video";
  if (mime === "application/pdf") return "pdf";
  if (mime === "text/csv" || mime === "text/tab-separated-values" || /(?:spreadsheet|excel)/.test(mime)) return "spreadsheet";
  if (/(?:presentation|powerpoint)/.test(mime)) return "presentation";
  if (/(?:wordprocessing|msword|opendocument\.text)/.test(mime)) return "document";
  if (/(?:zip|gzip|x-tar|x-7z|x-rar)/.test(mime)) return "archive";
  if (mime === "application/json" || mime === "application/xml" || /(?:javascript|typescript)/.test(mime)) return "code";
  return extensionKinds[extension] ?? (mime.startsWith("text/") ? "document" : "file");
}

export function attachmentFileIcon(name: string, mimeType: string): string {
  return iconByKind[attachmentFileKind(name, mimeType)];
}

export function attachmentFileLabel(name: string, mimeType: string): string {
  const kind = attachmentFileKind(name, mimeType);
  if (kind === "folder") return "";
  const basename = name.split(/[\\/]/).at(-1) ?? "";
  const extension = basename.lastIndexOf(".") > 0 ? basename.slice(basename.lastIndexOf(".") + 1) : "";
  if (/^[a-z0-9]{1,8}$/i.test(extension)) return extension.toUpperCase();
  return kind === "file" ? "FILE" : kind.toUpperCase();
}
