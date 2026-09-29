import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ImageContent } from "@earendil-works/pi-ai";
import type { MessageAttachmentInfo } from "@qone/protocol";
import { ffmpegExecutable } from "./reach-channels.js";

const execFileAsync = promisify(execFile);

export interface ExtractedVideoFrames {
  frames: { seconds: number; image: ImageContent }[];
  directory: string;
}

async function readableVideo(filePath: string): Promise<void> {
  const source = await stat(filePath);
  if (!source.isFile()) throw new Error("视频文件已不存在，无法读取画面");
}

/** Read container duration without decoding the video. Some streams do not declare one. */
export async function videoDuration(filePath: string, signal?: AbortSignal): Promise<number | undefined> {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw new Error("非 Gemini 视频理解需要 FFmpeg 来读取画面");
  await readableVideo(filePath);
  let stderr = "";
  try {
    const result = await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-i", filePath],
      { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
    stderr = result.stderr;
  } catch (error) {
    if (signal?.aborted) throw error;
    stderr = String((error as { stderr?: string }).stderr ?? "");
  }
  if (!/Input #\d+/.test(stderr)) throw new Error(`FFmpeg 无法读取视频文件：${stderr.trim().slice(-300) || "未知错误"}`);
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined;
}

/** Extract only requested moments; never materialize every codec key frame. */
export async function extractVideoFrames(filePath: string, timestamps: readonly number[], signal?: AbortSignal): Promise<ExtractedVideoFrames> {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw new Error("非 Gemini 视频理解需要 FFmpeg 来提取画面帧");
  await readableVideo(filePath);
  if (!timestamps.length || timestamps.some((seconds) => !Number.isFinite(seconds) || seconds < 0)) {
    throw new Error("请提供要读取的非负视频时间点（秒）");
  }
  const directory = await mkdtemp(path.join(tmpdir(), "qone-video-frames-"));
  try {
    const frames: ExtractedVideoFrames["frames"] = [];
    for (const [index, seconds] of timestamps.entries()) {
      const output = path.join(directory, `${index}.jpg`);
      await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-ss", String(seconds),
        "-i", filePath, "-frames:v", "1", "-q:v", "3", output],
        { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
      try {
        const image: ImageContent = { type: "image", data: (await readFile(output)).toString("base64"), mimeType: "image/jpeg" };
        frames.push({ seconds, image });
      } catch {
        throw new Error(`视频在 ${seconds} 秒处没有可读取的画面`);
      }
      await rm(output);
    }
    return { frames, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

async function attachmentPath(attachment: MessageAttachmentInfo): Promise<{ path: string; directory?: string }> {
  if (attachment.localPath) return { path: attachment.localPath };
  const match = /^data:(video\/[^;,]+);base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data);
  if (!match) throw new Error(`视频附件 ${attachment.name} 没有可读取的本地路径或 Base64 数据`);
  const directory = await mkdtemp(path.join(tmpdir(), "qone-inline-video-"));
  const filePath = path.join(directory, "source");
  await writeFile(filePath, Buffer.from(match[2]!, "base64"));
  return { path: filePath, directory };
}

export async function videoAttachmentFrames(
  attachment: MessageAttachmentInfo,
  timestamps: readonly number[] | undefined,
  registerDirectory: (directory: string) => void,
  signal?: AbortSignal,
): Promise<{ frames: ExtractedVideoFrames["frames"]; duration?: number }> {
  const source = await attachmentPath(attachment);
  try {
    if (!timestamps) return { frames: [], duration: await videoDuration(source.path, signal) };
    const result = await extractVideoFrames(source.path, timestamps, signal);
    registerDirectory(result.directory);
    return { frames: result.frames };
  } finally {
    if (source.directory) await rm(source.directory, { recursive: true, force: true });
  }
}
