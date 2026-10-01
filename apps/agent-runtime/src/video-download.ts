import { runtimeText, runtimeError } from "./runtime-localization";
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
  if (!["http:", "https:"].includes(parsed.protocol)) throw runtimeError("video-download.the_video_url_must_use_http_or_https", {});
  const executable = ytDlpExecutable();
  if (!executable) throw runtimeError("video-download.yt_dlp_was_not_found_cannot_download_the_video", {});
  const directory = await mkdtemp(path.join(tmpdir(), audioOnly ? "qone-audio-download-" : "qone-video-"));
  try {
    const ffmpeg = ffmpegExecutable();
    const args = ["--no-playlist", "--no-progress", "--no-warnings", "--print", "after_move:filepath",
      "--output", path.join(directory, "media.%(ext)s")];
    if (ffmpeg) args.push("--ffmpeg-location", path.dirname(ffmpeg));
    if (audioOnly) {
      if (!ffmpeg) throw runtimeError("video-download.audio_download_requires_ffmpeg_to_create_a_standard_mp3", {});
      args.push("--format", "bestaudio", "--extract-audio", "--audio-format", "mp3");
    }
    args.push(url);
    const { stdout } = await execFileAsync(executable, args, { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
    const filePath = stdout.trim().split(/\r?\n/).at(-1)?.trim();
    if (!filePath || path.dirname(path.resolve(filePath)) !== path.resolve(directory)) throw runtimeError("video-download.yt_dlp_returned_no_downloaded_file_path", {});
    const info = await stat(filePath);
    if (!info.isFile()) throw runtimeError("video-download.yt_dlp_did_not_create_a_video_file", {});
    const mimeType = audioOnly ? mediaMimeType(filePath) : videoMimeType(filePath);
    if (!mimeType || audioOnly && !mimeType.startsWith("audio/")) {
      throw runtimeError("video-download.could_not_identify_the_downloaded_format", { p0: audioOnly ? runtimeText("media-tool.audio") : runtimeText("media-tool.video"), p1: path.extname(filePath) || runtimeText("video-download.no_extension") });
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
  if (!ffmpeg) throw runtimeError("video-download.ffmpeg_was_not_found_cannot_extract_audio_from_the", {});
  const info = await stat(filePath);
  if (!info.isFile()) throw runtimeError("video-download.the_video_file_no_longer_exists_cannot_extract_audio", {});
  const directory = await mkdtemp(path.join(tmpdir(), "qone-audio-"));
  const output = path.join(directory, "audio.m4a");
  try {
    await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-i", filePath,
      "-vn", "-c:a", "aac", output], { signal, windowsHide: true, maxBuffer: 1024 * 1024 });
    if (!(await stat(output)).isFile()) throw runtimeError("video-download.ffmpeg_did_not_create_an_audio_file", {});
    return { path: output, directory, mimeType: "audio/mp4" };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
