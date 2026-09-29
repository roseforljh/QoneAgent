import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { MessageAttachmentInfo } from "@qone/protocol";
import { extractVideoAudio } from "./video-download.js";

export type RuntimeMediaAttachment = MessageAttachmentInfo & { temporary?: boolean };

/** Run only in the agent that will consume the sound; local user files are read in place. */
export async function videoAttachmentsAsAudio(
  attachments: readonly RuntimeMediaAttachment[] | undefined,
  registerDirectory: (directory: string) => void,
  signal?: AbortSignal,
): Promise<RuntimeMediaAttachment[] | undefined> {
  if (!attachments?.some((item) => item.mimeType.startsWith("video/"))) return attachments ? [...attachments] : undefined;
  const result: RuntimeMediaAttachment[] = [];
  for (const item of attachments) {
    if (!item.mimeType.startsWith("video/")) { result.push(item); continue; }
    let source = item.localPath;
    let staging: string | undefined;
    try {
      if (!source) {
        const match = /^data:(video\/[^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(item.data);
        if (!match) throw new Error(`视频附件 ${item.name} 没有可读取的本地路径或 Base64 数据`);
        staging = await mkdtemp(path.join(tmpdir(), "qone-inline-video-"));
        source = path.join(staging, "source");
        await writeFile(source, Buffer.from(match[2]!, "base64"));
      }
      const audio = await extractVideoAudio(source, signal);
      registerDirectory(audio.directory);
      result.push({ ...item, name: "audio.m4a", mimeType: audio.mimeType, data: "", localPath: audio.path, temporary: true });
    } finally {
      if (staging) await rm(staging, { recursive: true, force: true });
    }
  }
  return result;
}
