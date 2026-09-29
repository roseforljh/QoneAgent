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
