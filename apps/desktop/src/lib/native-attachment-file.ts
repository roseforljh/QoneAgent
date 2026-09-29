export const INLINE_ATTACHMENT_LIMIT_BYTES = 50 * 1024 * 1024;

export type NativeAttachmentFile = File & { qoneLocalPath?: string; qoneFileSize?: number };

export function createNativeAttachmentFile(name: string, mimeType: string, path: string, size: number): NativeAttachmentFile {
  const file = new File([], name, { type: mimeType }) as NativeAttachmentFile;
  Object.defineProperties(file, {
    qoneLocalPath: { value: path },
    qoneFileSize: { value: size },
  });
  return file;
}

export function isAudioVideo(mimeType: string): boolean {
  return /^(?:audio|video)\//i.test(mimeType);
}
