import { runtimeText, runtimeError } from "./runtime-localization";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, open, rename, rm, stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { qoneTemporaryDir } from "@qone/shared";
import path from "node:path";
import { promisify } from "node:util";
import { mediaMimeTypeFromName } from "@qone/protocol";
import { ffmpegExecutable, ytDlpExecutable } from "./reach-channels.js";
import type { DouyinBridgeResult } from "./douyin-bridge.js";

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
  const directory = await mkdtemp(path.join(qoneTemporaryDir(), audioOnly ? "qone-audio-download-" : "qone-video-"));
  try {
    const ffmpeg = ffmpegExecutable();
    const args = ["--no-playlist", "--no-progress", "--no-warnings", "--print", "after_move:filepath",
      "--output", path.join(directory, "media.%(ext)s")];
    if (ffmpeg) args.push("--ffmpeg-location", path.dirname(ffmpeg));
    if (audioOnly) {
      if (!ffmpeg) throw runtimeError("video-download.audio_download_requires_ffmpeg_to_create_a_standard_mp3", {});
      args.push("--format", "bestaudio", "--extract-audio", "--audio-format", "mp3");
    } else args.push("--format", ffmpeg ? "bv*+ba/b" : "best");
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

export async function downloadDouyinVideo(
  pageUrl: string,
  resolveVideo: (url: string, signal?: AbortSignal) => Promise<DouyinBridgeResult>,
  signal?: AbortSignal,
): Promise<DownloadedVideo> {
  const resolved = await resolveVideo(pageUrl, signal);
  const downloadSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(300_000)]) : AbortSignal.timeout(300_000);
  let lastError: unknown;
  // These are mirrors from one verified play_addr, never unrelated page media.
  for (const videoUrl of new Set([resolved.videoUrl, ...(resolved.videoUrls ?? [])])) {
    downloadSignal.throwIfAborted();
    try { return await downloadDouyinStream({ ...resolved, videoUrl, pageUrl: resolved.pageUrl || pageUrl }, downloadSignal); }
    catch (error) { downloadSignal.throwIfAborted(); lastError = error; }
  }
  throw lastError;
}

async function downloadDouyinStream(resolved: DouyinBridgeResult, downloadSignal: AbortSignal): Promise<DownloadedVideo> {
  const response = await fetch(resolved.videoUrl, {
    headers: {
      Referer: resolved.pageUrl,
      Origin: new URL(resolved.pageUrl).origin,
      Accept: "video/*,*/*;q=0.8",
      "Accept-Encoding": "identity",
      ...(resolved.userAgent && resolved.userAgent.length <= 512 ? { "User-Agent": resolved.userAgent } : {}),
    },
    signal: downloadSignal,
  });
  let directory: string | undefined;
  try {
    if (![200, 206].includes(response.status) || !response.body) throw runtimeError("video-download.douyin_stream_http", { p0: response.status });
    const range = /^bytes 0-(\d+)\/(\d+)$/.exec(response.headers.get("content-range") ?? "");
    if (response.status === 206 && (!range || Number(range[1]) + 1 !== Number(range[2]))) throw runtimeError("video-download.douyin_partial_stream", {});
    // Fetch decompresses bodies; encoded Content-Length cannot be compared with decoded bytes.
    const expectedLength = response.headers.get("content-encoding") ? undefined
      : response.status === 206 ? range![2] : response.headers.get("content-length");
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType && !["video/mp4", "video/webm", "video/quicktime", "application/octet-stream"].includes(contentType)) {
      throw runtimeError("video-download.douyin_non_video_response", { p0: contentType });
    }
    directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-douyin-video-"));
    const extension = contentType === "video/webm" ? "webm" : contentType === "video/quicktime" ? "mov" : "mp4";
    let filePath = path.join(directory, `media.${extension}`);
    await pipeline(Readable.fromWeb(response.body as never), createWriteStream(filePath, { flags: "wx" }), { signal: downloadSignal });
    const info = await stat(filePath);
    if (!info.isFile() || info.size === 0) throw runtimeError("video-download.douyin_empty_file", {});
    if (expectedLength && info.size !== Number(expectedLength)) throw runtimeError("video-download.douyin_incomplete_stream", { p0: expectedLength, p1: info.size });
    const file = await open(filePath, "r");
    let isWebm = false;
    try {
      const header = Buffer.alloc(12);
      const { bytesRead } = await file.read(header, 0, header.length, 0);
      isWebm = bytesRead >= 12 && header.readUInt32BE(0) === 0x1a45dfa3;
      if (bytesRead < 12 || !(header.toString("ascii", 4, 8) === "ftyp" || isWebm)) {
        throw runtimeError("video-download.douyin_non_video_response", { p0: contentType || "unknown" });
      }
    } finally { await file.close(); }
    const mimeType = isWebm ? "video/webm" : contentType === "video/quicktime" ? "video/quicktime" : "video/mp4";
    const finalPath = path.join(directory, `media.${isWebm ? "webm" : mimeType === "video/quicktime" ? "mov" : "mp4"}`);
    if (filePath !== finalPath) {
      await rename(filePath, finalPath);
      filePath = finalPath;
    }
    downloadSignal.throwIfAborted();
    return { path: filePath, mimeType, directory };
  } catch (error) {
    if (directory) await rm(directory, { recursive: true, force: true });
    throw error;
  } finally {
    if (response.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}

/** Extract the sound track in the consuming audio agent, without downloading again. */
export async function extractVideoAudio(filePath: string, signal?: AbortSignal): Promise<{ path: string; directory: string; mimeType: "audio/mp4" }> {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) throw runtimeError("video-download.ffmpeg_was_not_found_cannot_extract_audio_from_the", {});
  const info = await stat(filePath);
  if (!info.isFile()) throw runtimeError("video-download.the_video_file_no_longer_exists_cannot_extract_audio", {});
  const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-audio-"));
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
