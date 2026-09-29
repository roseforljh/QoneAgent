import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { mediaMimeTypeFromName } from "@qone/protocol";
import { ffmpegExecutable, ytDlpExecutable } from "./reach-channels.js";

const execFileAsync = promisify(execFile);
export interface DownloadedVideo {
  path: string;
  mimeType: string;
  directory: string;
}

export function videoMimeType(filePath: string): string | undefined {
  const mimeType = mediaMimeTypeFromName(filePath);
  return mimeType?.startsWith("video/") ? mimeType : undefined;
}

export function mediaMimeType(filePath: string): string | undefined {
  return mediaMimeTypeFromName(filePath);
}

/** Download only for the agent that will actually inspect the media. Caller owns cleanup. */
async function downloadMedia(url: string, audioOnly: boolean, signal?: AbortSignal): Promise<DownloadedVideo> {
  const parsed = new URL(url);
  if (!["http:", "https:"].includes(parsed.protocol)) throw new Error("视频地址必须是 HTTP 或 HTTPS 链接");
  const executable = ytDlpExecutable();
  if (!executable) throw new Error("未找到 yt-dlp，无法下载视频");
  const directory = await mkdtemp(path.join(tmpdir(), audioOnly ? "qone-audio-download-" : "qone-video-"));
  try {
    const ffmpeg = ffmpegExecutable();
    const args = ["--no-playlist", "--no-progress", "--no-warnings", "--print", "after_move:filepath",
      "--output", path.join(directory, "media.%(ext)s")];
    if (ffmpeg) args.push("--ffmpeg-location", path.dirname(ffmpeg));
    if (audioOnly) {
      if (!ffmpeg) throw new Error("音频下载需要 FFmpeg 来生成通用 MP3 文件");
      args.push("--format", "bestaudio", "--extract-audio", "--audio-format", "mp3");
    }
    args.push(url);
    const { stdout } = await execFileAsync(executable, args, { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
    const filePath = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (!filePath || path.dirname(path.resolve(filePath)) !== path.resolve(directory)) throw new Error("yt-dlp 未返回下载文件路径");
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("yt-dlp 未生成视频文件");
    const mimeType = audioOnly ? mediaMimeType(filePath) : videoMimeType(filePath);
    if (!mimeType || audioOnly && !mimeType.startsWith("audio/")) {
      throw new Error(`无法识别下载的${audioOnly ? "音频" : "视频"}格式：${path.extname(filePath) || "无扩展名"}`);
    }
    return { path: filePath, mimeType, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export function downloadVideo(url: string, signal?: AbortSignal): Promise<DownloadedVideo> {
  return downloadMedia(url, false, signal);
}

export function downloadAudio(url: string, signal?: AbortSignal): Promise<DownloadedVideo> {
  return downloadMedia(url, true, signal);
}

/** Extract the sound track in the consuming audio agent, without downloading again. */
export async function extractVideoAudio(filePath: string, signal?: AbortSignal): Promise<{ path: string; directory: string; mimeType: "audio/mp4" }> {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw new Error("未找到 FFmpeg，无法从视频中提取音频");
  const info = await stat(filePath);
  if (!info.isFile()) throw new Error("视频文件已不存在，无法提取音频");
  const directory = await mkdtemp(path.join(tmpdir(), "qone-audio-"));
  const output = path.join(directory, "audio.m4a");
  try {
    await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-vn", "-c:a", "aac", output], { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (!(await stat(output)).isFile()) throw new Error("FFmpeg 未生成音频文件");
    return { path: output, directory, mimeType: "audio/mp4" };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
