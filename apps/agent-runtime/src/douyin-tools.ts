import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { douyinContentId } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { createReadStream, createWriteStream } from "node:fs";
import { link, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Type } from "typebox";
import { DouyinBridgeError, type DouyinBridge } from "./douyin-bridge.js";
import { LocalizedRuntimeError, runtimeError, runtimeText } from "./runtime-localization.js";
import { downloadDouyinVideo, type DownloadedVideo } from "./video-download.js";

interface SavedVideo { contentId: string; url: string; status: "saved" | "exists" | "failed"; path?: string; error?: string }
const log = createLogger("douyin-download");
export const DOUYIN_ROUTING_GUIDANCE = "[QONE_DOUYIN_ROUTING]\nDouyin uses Qone's dedicated embedded page bridge. For a video/share/short URL, call qone_douyin_resolve_author to identify its creator. For a creator's first N videos, use qone_douyin_list_videos then qone_douyin_download to persist the returned URLs. For recognition, qone_video_download already uses the embedded bridge. Do not pre-open Douyin with qone_browser_*, generic OpenCLI, curl or shell scripts, and do not extract cookie files. Old generic browser observations do not override this route. If embedded metadata is unavailable, report the failure instead of switching browser sessions. These tools reuse Qone's browser profile themselves.\n[/QONE_DOUYIN_ROUTING]";

/** These tools save files, without requiring the model to have video/audio input. */
export function createDouyinTools(
  bridge: Pick<DouyinBridge, "request" | "listAuthor" | "resolveAuthor">,
  workspacePath: string,
  download = (url: string, signal?: AbortSignal): Promise<DownloadedVideo> => downloadDouyinVideo(url, (target, abort) => bridge.request(target, abort), signal),
): ToolDefinition[] {
  return [{
    name: "qone_douyin_list_videos",
    label: "Douyin · list creator videos",
    description: "List the first N videos from a complete Douyin creator homepage URL using Qone's logged-in embedded browser. The post-list order includes pinned videos; this is not a global newest-by-date sort. Filters image posts and other authors, deduplicates and loads more pages when needed. Check authorId, nickname and completion before downloading. completion=limit means N found; exhausted means fewer exist; timeout/stalled/blocked means incomplete, never invent missing videos. Find and verify the creator's full /user/ URL first; a nickname alone is not a unique account identity.",
    promptSnippet: DOUYIN_ROUTING_GUIDANCE,
    parameters: Type.Object({ url: Type.String({ minLength: 1 }), limit: Type.Integer({ minimum: 1, maximum: 100 }) }),
    execute: async (_id, params, signal) => {
      const { url, limit } = params as { url: string; limit: number };
      const result = await bridge.listAuthor(url, limit, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result,
        isError: !result.videos.length && result.completion !== "exhausted" };
    },
  }, {
    name: "qone_douyin_download",
    label: "Douyin · save videos",
    description: "Persist complete Douyin /video/ URLs or modal_id links to disk using the embedded logged-in page bridge, without video-recognition requirements. Use URLs from qone_douyin_list_videos for creator batches; profile URLs, image posts and unresolved short links are not video work IDs. path is the user's destination directory (relative to the workspace, or absolute); omitted path defaults to downloads/douyin under the workspace. Preserves input order, deduplicates work IDs, names files by ID, never overwrites existing files. Returns per-file saved/exists/failed status and absolute paths; failures do not count as downloads. Page/bridge failures stop the batch: report stopped, stopReason and remaining, and do not immediately retry the unchanged batch. A confirmed unavailable work or CDN failure is recorded per file and does not stop other works. Completed files survive cancellation and task cleanup. This saves files only, and does not claim to recognize video content.",
    parameters: Type.Object({ urls: Type.Array(Type.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }), path: Type.Optional(Type.String({ minLength: 1 })) }),
    execute: async (_id, params, signal, onUpdate) => {
      const input = params as { urls: string[]; path?: string };
      if (!Array.isArray(input.urls) || input.urls.length < 1 || input.urls.length > 100) throw runtimeError("douyin-bridge.invalid_limit", {});
      const works = new Map<string, string>();
      for (const value of input.urls) {
        const url = typeof value === "string" ? value.trim() : "";
        const id = douyinContentId(url);
        if (!id || !/^\/(?:share\/)?video\//.test(new URL(url).pathname) && !new URL(url).searchParams.has("modal_id")) {
          throw runtimeError("douyin-tools.invalid_video_link", {});
        }
        works.set(id, url);
      }
      if (input.path !== undefined && (typeof input.path !== "string" || !input.path.trim() || input.path.includes("\0"))) {
        throw runtimeError("douyin-tools.invalid_destination", {});
      }
      signal?.throwIfAborted();
      const destination = path.resolve(workspacePath, input.path?.trim() || path.join("downloads", "douyin"));
      await mkdir(destination, { recursive: true });
      const results: SavedVideo[] = [];
      let stopReason: string | undefined;
      const update = (phase: "downloading" | "completed" | "stopped", contentId: string) => {
        const details = { total: works.size, results, phase, current: contentId, remaining: works.size - results.length,
          cancelled: Boolean(signal?.aborted), ...(stopReason ? { stopReason } : {}) };
        onUpdate?.({ content: [{ type: "text", text: JSON.stringify(details) }], details });
      };
      for (const [contentId, url] of works) {
        if (signal?.aborted) break;
        let downloaded: DownloadedVideo | undefined;
        const staging = path.join(destination, `.${contentId}-${crypto.randomUUID()}.part`);
        try {
          update("downloading", contentId);
          signal?.throwIfAborted();
          downloaded = await download(url, signal);
          signal?.throwIfAborted();
          const filePath = path.join(destination, `${contentId}${path.extname(downloaded.path)}`);
          // Stage on the destination volume. A hard link publishes the complete file
          // atomically and fails with EEXIST instead of replacing someone else's file.
          await pipeline(createReadStream(downloaded.path), createWriteStream(staging, { flags: "wx" }), { signal });
          signal?.throwIfAborted();
          try {
            await link(staging, filePath);
            results.push({ contentId, url, status: "saved", path: filePath });
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            results.push({ contentId, url, status: "exists", path: filePath });
          }
        } catch (error) {
          if (!signal?.aborted) results.push({ contentId, url, status: "failed",
            error: error instanceof LocalizedRuntimeError ? error.message
              : runtimeText("douyin-tools.download_failed", { p0: (error as { code?: string })?.code || "unknown" }) });
          if (error instanceof DouyinBridgeError && error.failure !== "work_unavailable") stopReason = error.message;
        } finally {
          // A cleanup failure must not discard the record of already saved files.
          await rm(staging, { force: true }).catch((error) => log.warn("staging cleanup failed", { error: String(error) }));
          if (downloaded) await rm(downloaded.directory, { recursive: true, force: true })
            .catch((error) => log.warn("download cleanup failed", { error: String(error) }));
        }
        update(stopReason ? "stopped" : "completed", contentId);
        if (stopReason) break;
      }
      const result = { directory: destination, requested: works.size, saved: results.filter((item) => item.status === "saved").length,
        existing: results.filter((item) => item.status === "exists").length, failed: results.filter((item) => item.status === "failed").length,
        cancelled: Boolean(signal?.aborted), stopped: Boolean(stopReason), remaining: works.size - results.length,
        ...(stopReason ? { stopReason } : {}), results };
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: result.cancelled || result.failed > 0 };
    },
  }, {
    name: "qone_douyin_resolve_author",
    label: "Douyin · identify video creator",
    description: "Resolve a Douyin video or v.douyin.com share/short link in Qone's embedded logged-in browser, then return the creator's verified profileUrl, authorId, nickname and contentId from matching work metadata. Use this before qone_douyin_list_videos when the user supplies a video/share link rather than a /user/ homepage. No OpenCLI, Chrome, shell redirects or cookie extraction are required. Does not guess from unrelated profile links or recommendations.",
    parameters: Type.Object({ url: Type.String({ minLength: 1 }) }),
    execute: async (_id, params, signal) => {
      const result = await bridge.resolveAuthor((params as { url: string }).url, signal);
      return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
    },
  }];
}
