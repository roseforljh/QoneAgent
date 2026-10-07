import { execFile } from "node:child_process";
import { mkdtemp, rm, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { createLogger, qoneTemporaryDir } from "@qone/shared";
import { mediaAppContentId, mediaAppFromUrl, mediaAppHostIsAlias, mediaAppProfile, siteForAppId, type AppMediaItem, type AppMediaList, type MediaAppId, type MediaAppMode } from "@qone/protocol";
import { ytDlpExecutable, ffmpegExecutable } from "./reach-channels";
import { LocalizedRuntimeError, runtimeError } from "./runtime-localization";
import type { DownloadedVideo } from "./video-download";
import { mediaMimeType } from "./video-download";

const execFileAsync = promisify(execFile);
const log = createLogger("app-media");
type Runner = (command: string, args: string[], signal: AbortSignal) => Promise<{ stdout: string }>;

function failureCategory(error: unknown): string {
  if (error && typeof error === "object") {
    const value = error as { code?: unknown; name?: unknown };
    if (typeof value.code === "string" && /^[a-z0-9._-]+$/i.test(value.code)) return value.code;
    if (typeof value.name === "string" && /^[a-z0-9._-]+$/i.test(value.name)) return value.name;
  }
  return "unknown";
}

export class AppMediaError extends LocalizedRuntimeError {
  constructor(readonly stage: "session" | "inspect" | "download", app: MediaAppId, reason: string) {
    super("app-media.operation_failed", { p0: app, p1: stage, p2: reason });
  }
}
export interface AppMediaDownload { item: AppMediaItem; files: DownloadedVideo[]; directory: string }

function assertAppUrl(app: MediaAppId, url: string): void {
  if (mediaAppFromUrl(url) !== app) throw runtimeError("app-media.invalid_url", { p0: app });
}

/** Share the mature extractor/format selection used by upstream's yt-dlp plugin. */
export class AppMediaService {
  constructor(
    private readonly runner: Runner = async (command, args, signal) => execFileAsync(command, args,
      { signal, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }),
    private readonly extractor = ytDlpExecutable) {}

  private async run<T>(app: MediaAppId, stage: "inspect" | "download", url: string, args: string[], signal: AbortSignal | undefined,
    consume: (stdout: string, directory: string) => Promise<T>, keep = false): Promise<T> {
    assertAppUrl(app, url);
    signal?.throwIfAborted();
    const executable = this.extractor();
    if (!executable) {
      log.warn("media operation blocked: extractor missing", { app, stage });
      throw runtimeError("app-media.extractor_missing");
    }
    const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-app-media-"));
    let retained = false;
    try {
      log.info("media operation started", { app, stage });
      const timeout = AbortSignal.timeout(stage === "download" ? 300_000 : 120_000);
      const operationSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
      const common = ["--no-warnings", "--no-progress", "--socket-timeout", "30", "--retries", "2"];
      if (app === "youtube") common.push("--js-runtimes", `bun:${process.execPath}`);
      const ffmpeg = ffmpegExecutable();
      if (ffmpeg) common.push("--ffmpeg-location", path.dirname(ffmpeg));
      let stdout: string;
      try { ({ stdout } = await this.runner(executable, [...common, ...args.map((arg) => arg.replace("{directory}", directory)), "--", url], operationSignal)); }
      catch (error) {
        signal?.throwIfAborted();
        log.warn("media operation failed", { app, stage, reason: operationSignal.aborted ? "timeout" : failureCategory(error) });
        // Child errors contain signed URLs, cookies and the complete argv. Keep
        // machine status only, never return stdout/stderr to tools or log them.
        throw new AppMediaError(stage, app, operationSignal.aborted ? "timeout" : String((error as { code?: unknown }).code ?? "extractor"));
      }
      let result: T;
      try { result = await consume(stdout, directory); }
      catch (error) {
        log.warn("media operation failed", { app, stage, reason: failureCategory(error) });
        throw error;
      }
      signal?.throwIfAborted();
      retained = keep;
      log.info("media operation completed", { app, stage, retained: keep });
      return result;
    } finally { if (!retained) await rm(directory, { recursive: true, force: true }); }
  }

  async inspect(app: MediaAppId, url: string, signal?: AbortSignal): Promise<AppMediaItem> {
    if (!mediaAppContentId(app, url) && !isShortLink(app, url)) throw runtimeError("app-media.work_link_required");
    return this.run(app, "inspect", url, ["--dump-single-json", "--skip-download", ...(app === "x" ? [] : ["--no-playlist"])], signal,
      async (stdout) => {
        let data: unknown;
        try { data = JSON.parse(stdout); } catch { throw new AppMediaError("inspect", app, "invalid_json"); }
        if (!data || typeof data !== "object") throw new AppMediaError("inspect", app, "invalid_json");
        const item = normalizeAppItem(app, data as Record<string, any>, url);
        if (!item || mediaAppContentId(app, url) && item.id !== mediaAppContentId(app, url)) throw runtimeError("app-media.content_mismatch");
        return item;
      });
  }

  async list(app: MediaAppId, url: string, limit: number, signal?: AbortSignal): Promise<AppMediaList> {
    assertAppUrl(app, url);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !mediaAppProfile(app, url)) throw runtimeError("app-media.profile_link_required");
    const target = app === "youtube" && !new URL(url).searchParams.has("list")
      ? url.replace(/\/(?:videos|shorts)\/?$/, "").replace(/\/$/, "") + (new URL(url).pathname.endsWith("/shorts") ? "/shorts" : "/videos") : url;
    return this.run(app, "inspect", target, ["--dump-single-json", "--skip-download", "--flat-playlist", "--playlist-end", String(limit)], signal,
      async (stdout) => {
        let data: unknown;
        try { data = JSON.parse(stdout); } catch { throw new AppMediaError("inspect", app, "invalid_json"); }
        if (!data || typeof data !== "object") throw new AppMediaError("inspect", app, "invalid_json");
        const items = new Map<string, AppMediaItem>();
        const record = data as Record<string, any>;
        for (const entry of Array.isArray(record.entries) ? record.entries : []) {
          const item = normalizeAppItem(app, entry);
          if (item) items.set(item.id, item);
        }
        const complete = items.size === limit ? "limit" : Array.isArray(record.entries) && record.entries.every(Boolean) ? "exhausted" : "stalled";
        return { app, url, items: [...items.values()].slice(0, limit), completion: complete };
      });
  }

  async download(app: MediaAppId, url: string, mode: MediaAppMode, languages: string[] | undefined, signal?: AbortSignal): Promise<AppMediaDownload> {
    if (!mediaAppContentId(app, url) && !isShortLink(app, url)) throw runtimeError("app-media.work_link_required");
    if (!mode || !["video", "audio", "subtitles"].includes(mode)) throw runtimeError("app-media.invalid_mode");
    if (mode === "subtitles" && (app !== "youtube" || !languages?.length || languages.some((language) => !/^[a-zA-Z0-9_-]+$/.test(language)))) {
      throw runtimeError("app-media.subtitle_languages_required");
    }
    if (mode === "audio" && !ffmpegExecutable()) throw runtimeError("video-download.audio_download_requires_ffmpeg_to_create_a_standard_mp3");
    // Resolve and validate the canonical work before publishing anything. A
    // short link or a multi-video tweet may have a different extractor media ID.
    const item = await this.inspect(app, url, signal);
    const options = ["--output", "{directory}/media.%(id)s.%(ext)s", "--print", "after_move:filepath"];
    if (app !== "x") options.push("--no-playlist");
    if (mode === "audio") options.push("--format", "bestaudio/best", "--extract-audio", "--audio-format", "mp3");
    else if (mode === "subtitles") options.push("--skip-download", "--write-subs", "--write-auto-subs", "--sub-langs", languages!.join(","), "--sub-format", "vtt/srt/best");
    else options.push("--format", ffmpegExecutable() ? "bv*+ba/b" : "best");
    return this.run(app, "download", item.url, options, signal, async (stdout, directory) => {
      const { readdir } = await import("node:fs/promises");
      const paths = mode === "subtitles" ? (await readdir(directory)).filter((name) => /\.(vtt|srt|ttml)$/.test(name)).map((name) => path.join(directory, name))
        : stdout.trim().split(/\r?\n/).filter(Boolean).map((line) => path.resolve(line));
      const files: DownloadedVideo[] = [];
      for (const filePath of [...new Set(paths)]) {
        if (path.dirname(path.resolve(filePath)) !== path.resolve(directory)) throw runtimeError("app-media.invalid_output");
        const info = await stat(filePath);
        const mimeType = mode === "subtitles" ? /\.vtt$/.test(filePath) ? "text/vtt" : "text/plain" : mediaMimeType(filePath);
        if (!info.isFile() || !info.size || !mimeType || mode === "video" && !mimeType.startsWith("video/")
          || mode === "audio" && !mimeType.startsWith("audio/")) throw runtimeError("app-media.invalid_output");
        files.push({ path: filePath, directory, mimeType });
      }
      if (!files.length) throw runtimeError("app-media.no_output");
      return { item, files, directory };
    }, true);
  }
}

function isShortLink(app: MediaAppId, url: string): boolean {
  if (mediaAppFromUrl(url) !== app) return false;
  return mediaAppHostIsAlias(app, new URL(url).hostname);
}

function youtubeWatchUrl(id: string): string {
  const url = new URL("watch", siteForAppId("youtube")!.homeUrl);
  url.searchParams.set("v", id);
  return url.toString();
}

/** Whitelist public metadata: formats, request headers and cookies stay private. */
export function normalizeAppItem(app: MediaAppId, raw: Record<string, any>, fallbackUrl?: string): AppMediaItem | undefined {
  if (!raw || typeof raw !== "object") return;
  const tiktokProfile = typeof raw.uploader_url === "string" && mediaAppProfile(app, raw.uploader_url);
  const tiktokFallback = app === "tiktok" && typeof raw.id === "string" && tiktokProfile
    ? `${String(raw.uploader_url).replace(/\/$/, "")}/video/${raw.id}` : undefined;
  const url = [raw.webpage_url, raw.original_url, raw.url, fallbackUrl, tiktokFallback,
    app === "youtube" && typeof raw.id === "string" ? youtubeWatchUrl(raw.id) : undefined]
    .find((value) => typeof value === "string" && mediaAppContentId(app, value));
  if (!url) return;
  const id = mediaAppContentId(app, url)!;
  if (app === "youtube" && raw.id !== id || app === "tiktok" && String(raw.id) !== id) return;
  const description = typeof raw.description === "string" ? raw.description : "";
  return { id, url, title: String(raw.title || ""), description: description.slice(0, 12000), descriptionTruncated: description.length > 12000,
    author: String(raw.uploader || raw.channel || raw.creator || ""),
    ...(typeof raw.uploader_url === "string" && mediaAppFromUrl(raw.uploader_url) === app ? { authorUrl: raw.uploader_url } : {}),
    ...(typeof raw.duration === "number" && Number.isFinite(raw.duration) ? { duration: raw.duration } : {}),
    ...(Array.isArray(raw.entries) ? { mediaCount: raw.entries.length } : {}) };
}
