import { runtimeText, runtimeError } from "./runtime-localization";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { qoneTemporaryDir } from "@qone/shared";
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
  if (!source.isFile()) throw runtimeError("video-frames.the_video_file_no_longer_exists_cannot_read_frames", {});
}

/** Read container duration without decoding the video. Some streams do not declare one. */
export async function videoDuration(filePath: string, signal?: AbortSignal): Promise<number | undefined> {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw runtimeError("video-frames.video_understanding_outside_gemini_requires_ffmpeg_to_read_frames", {});
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
  if (!/Input #\d+/.test(stderr)) throw runtimeError("video-frames.ffmpeg_could_not_read_the_video_file", { p0: stderr.trim().slice(-300) || runtimeText("video-frames.unknown_error") });
  const match = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(stderr);
  return match ? Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) : undefined;
}

/** Extract only requested moments; never materialize every codec key frame. */
export async function extractVideoFrames(filePath: string, timestamps: readonly number[], signal?: AbortSignal): Promise<ExtractedVideoFrames> {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw runtimeError("video-frames.video_understanding_outside_gemini_requires_ffmpeg_to_extract_frames", {});
  await readableVideo(filePath);
  if (!timestamps.length || timestamps.some((seconds) => !Number.isFinite(seconds) || seconds < 0)) {
    throw runtimeError("video-frames.provide_non_negative_video_timestamps_in_seconds", {});
  }
  const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-video-frames-"));
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
        throw runtimeError("video-frames.no_readable_video_frame_at_seconds", { p0: seconds });
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
  if (!match) throw runtimeError("media-attachments.video_attachment_has_no_readable_local_path_or_base64", { p0: attachment.name });
  const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-inline-video-"));
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
