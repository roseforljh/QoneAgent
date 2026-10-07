import { runtimeText, runtimeError } from "./runtime-localization";
import { execFile } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { qoneTemporaryDir } from "@qone/shared";
import { mediaAppContentId, siteMatchesHost } from "@qone/protocol";
import path from "node:path";
import { promisify } from "node:util";
import type { EmbeddedOpenCliRunner } from "./browser-sync.js";
import { biliLaunch } from "./reach-channels.js";
import { mediaMimeType, type DownloadedVideo } from "./video-download.js";

const execFileAsync = promisify(execFile);
const pythonOptions = { windowsHide: true, env: { ...process.env, PYTHONUTF8: "1", PYTHONIOENCODING: "utf-8" } };
const OPENCLI_READ_TIMEOUT = 300_000;
const AUDIO_MIME: Record<string, string> = {
  ".m4a": "audio/mp4", ".mp3": "audio/mpeg", ".wav": "audio/wav", ".aac": "audio/aac", ".flac": "audio/flac",
};

export function bilibiliCliResultText(stdout: string): string {
  const text = stdout.trim();
  if (!text) throw runtimeError("bilibili-fallback.bilibili_cli_returned_no_data", {});
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw runtimeError("bilibili-fallback.bilibili_cli_returned_invalid_json", {}); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw runtimeError("bilibili-fallback.invalid_bilibili_cli_response_format", {});
  const envelope = value as Record<string, unknown>;
  if (envelope.ok === false) {
    throw runtimeError("bilibili-fallback.bilibili_cli_failed_to_retrieve_data", { p0: JSON.stringify(envelope.error ?? envelope) });
  }
  return text;
}

export function isBilibiliUrl(value: string): boolean {
  try {
    const host = new URL(value).hostname.toLowerCase();
    return siteMatchesHost("bilibili", host);
  } catch { return false; }
}

export async function readBilibiliVideoData(read: (subtitles: boolean) => Promise<string>, signal?: AbortSignal): Promise<string> {
  try {
    return bilibiliCliResultText(await read(true));
  } catch (error) {
    if (signal?.aborted) throw error;
    return bilibiliCliResultText(await read(false));
  }
}

async function firstMediaFile(directory: string, mime: (file: string) => string | undefined): Promise<{ path: string; mimeType: string } | undefined> {
  const pending = [directory];
  for (const current of pending) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const mediaPath = path.join(current, entry.name);
      if (entry.isDirectory()) pending.push(mediaPath);
      if (!entry.isFile()) continue;
      const mimeType = mime(mediaPath);
      if (mimeType) return { path: mediaPath, mimeType };
    }
  }
  return undefined;
}

export interface BilibiliFallbackResult {
  source: "bilibili-cli" | "OpenCLI";
  text: string;
  audio?: { path: string; mimeType: string; directory: string };
}

export interface BilibiliOpenCliDownloadResult {
  id?: string;
  files: DownloadedVideo[];
  directory: string;
}

async function mediaFiles(directory: string): Promise<DownloadedVideo[]> {
  const pending = [directory];
  const files: DownloadedVideo[] = [];
  for (const current of pending) {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const filePath = path.join(current, entry.name);
      if (entry.isDirectory()) { pending.push(filePath); continue; }
      if (!entry.isFile()) continue;
      const mimeType = mediaMimeType(filePath);
      if (mimeType?.startsWith("video/")) files.push({ path: filePath, mimeType, directory });
    }
  }
  return files;
}

/** Run only after the embedded yt-dlp route failed. The caller owns the returned directory. */
export async function downloadBilibiliOpenCli(url: string, signal: AbortSignal | undefined, openCli: EmbeddedOpenCliRunner): Promise<BilibiliOpenCliDownloadResult> {
  if (!isBilibiliUrl(url)) throw runtimeError("bilibili-fallback.this_is_not_a_bilibili_video_url", {});
  const reference = /\bBV[A-Za-z0-9]+\b/i.exec(url)?.[0] ?? url;
  const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-bili-opencli-"));
  try {
    const result = await openCli("bilibili", ["bilibili", "download", reference, "--output", directory, "--format", "json"], 300_000, signal);
    const files = await mediaFiles(directory);
    if (!files.length) throw runtimeError("bilibili-fallback.opencli_download_returned_no_file", {});
    let id = mediaAppContentId("bilibili", url);
    try {
      const value: unknown = JSON.parse(result.stdout);
      const records = Array.isArray(value) ? value : [value];
      const bvid = records.find((item) => item && typeof item === "object" && typeof (item as Record<string, unknown>).bvid === "string") as Record<string, unknown> | undefined;
      if (typeof bvid?.bvid === "string" && /^BV[A-Za-z0-9]+$/i.test(bvid.bvid)) id = bvid.bvid;
    } catch { /* The file itself is the source of truth; metadata is optional. */ }
    return { id, files, directory };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

/** These sources provide partial evidence only; the caller must label the result as degraded. */
export async function readBilibiliFallback(url: string, signal: AbortSignal | undefined, openCli: EmbeddedOpenCliRunner): Promise<BilibiliFallbackResult> {
  if (!isBilibiliUrl(url)) throw runtimeError("bilibili-fallback.this_is_not_a_bilibili_video_url", {});
  const bvid = /\bBV[A-Za-z0-9]+\b/i.exec(url)?.[0];
  const reference = bvid ?? url;
  const launch = biliLaunch();
  const errors: string[] = [];
  if (launch) {
    try {
      const text = await readBilibiliVideoData(async (subtitles) => {
        const result = await execFileAsync(launch.command, [...launch.prefix, "video", reference, ...(subtitles ? ["--subtitle-timeline"] : []), "--json"], {
          ...pythonOptions, signal, timeout: OPENCLI_READ_TIMEOUT, maxBuffer: 16 * 1024 * 1024,
        });
        return result.stdout;
      }, signal);
      if (text) {
        const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-bili-audio-"));
        try {
          await execFileAsync(launch.command, [...launch.prefix, "audio", reference, "--no-split", "-o", directory], {
            ...pythonOptions, signal, timeout: OPENCLI_READ_TIMEOUT, maxBuffer: 1024 * 1024,
          });
          const audio = await firstMediaFile(directory, (file) => mediaMimeType(file)?.startsWith("audio/") ? AUDIO_MIME[path.extname(file).toLowerCase()] : undefined);
          if (audio) return { source: "bilibili-cli", text: text.trim(), audio: { ...audio, directory } };
        } catch (error) {
          await rm(directory, { recursive: true, force: true });
          if (signal?.aborted) throw error;
          // The optional audio extra or source audio may be unavailable.
        }
        await rm(directory, { recursive: true, force: true });
        return { source: "bilibili-cli", text: text.trim() };
      }
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`bilibili-cli: ${String(error)}`);
    }
  } else {
    errors.push(runtimeText("bilibili-fallback.bilibili_cli_is_not_installed"));
  }
  const parts: string[] = [];
  for (const command of ["subtitle", "summary"] as const) {
    try {
      const result = await openCli("bilibili", ["bilibili", command, url, "-f", "json"], OPENCLI_READ_TIMEOUT, signal);
      if (result.stdout) parts.push(`${command}: ${result.stdout}`);
    } catch (error) {
      if (signal?.aborted) throw error;
      errors.push(`OpenCLI ${command}: ${String(error)}`);
    }
  }
  if (!parts.length) throw runtimeError("bilibili-fallback.could_not_retrieve_the_full_bilibili_video_subtitles_audio", { p0: errors.join("；") });
  return { source: "OpenCLI", text: parts.join("\n\n") };
}
