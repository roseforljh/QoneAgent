const MEDIA_MIME_BY_EXTENSION: Record<string, string> = {
  mp4: "video/mp4", m4v: "video/mp4", mov: "video/quicktime",
  webm: "video/webm", mkv: "video/x-matroska", avi: "video/x-msvideo",
  flv: "video/x-flv", mpeg: "video/mpeg", mpg: "video/mpeg",
  "3gp": "video/3gpp", m2ts: "video/mp2t",
  m4a: "audio/mp4", mp3: "audio/mpeg", wav: "audio/wav",
  aac: "audio/aac", flac: "audio/flac", ogg: "audio/ogg", opus: "audio/opus",
};

export function mediaMimeTypeFromName(fileName: string): string | undefined {
  const extension = /\.([^.\\/]+)$/.exec(fileName)?.[1]?.toLowerCase();
  return extension ? MEDIA_MIME_BY_EXTENSION[extension] : undefined;
}

const FILE_MIME_BY_EXTENSION: Record<string, string> = {
  avif: "image/avif",
  bmp: "image/bmp",
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  ico: "image/x-icon",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  svg: "image/svg+xml",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

/** Media types first, then common document and image types; undefined for everything else. */
export function fileMimeTypeFromName(fileName: string): string | undefined {
  const extension = /\.([^.\\/]+)$/.exec(fileName)?.[1]?.toLowerCase();
  return extension ? MEDIA_MIME_BY_EXTENSION[extension] ?? FILE_MIME_BY_EXTENSION[extension] : undefined;
}
