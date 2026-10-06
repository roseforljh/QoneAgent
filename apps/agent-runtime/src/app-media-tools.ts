import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MEDIA_APP_IDS, mediaAppContentId, type MediaAppId, type MediaAppMode } from "@qone/protocol";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AppMediaService } from "./app-media-service.js";
import { downloadBilibiliOpenCli } from "./bilibili-fallback.js";
import { runtimeError } from "./runtime-localization.js";

const appType = Type.Union(MEDIA_APP_IDS.map((app) => Type.Literal(app)));
export const APP_MEDIA_ROUTING_GUIDANCE = "[QONE_APP_MEDIA_ROUTING]\nFor TikTok, Bilibili, YouTube, X and Reddit media download or video understanding tasks, use Qone's media tools: qone_app_inspect only when the user clearly asks about a specific media item, qone_app_download only when the user asks to save a copy, and qone_video_download followed by qone_video_use_file for understanding or summaries. A normal X or Reddit post URL is a social-content task, not a media-inspection task. For X and Reddit searches, posts, profiles, comments, communities, timelines, or account pages, use qone_opencli_discover followed by qone_opencli_run directly, even when the URL is public; do not use qone_app_inspect or qone_browser_* first. Qone routes OpenCLI through the matching embedded app session when a saved login exists, then falls back to the external browser bridge. Telegram needs its separate TDLib setup and must report that setup state instead of pretending a web Cookie is enough. Keep signed media URLs and cookies out of model-facing output.\n[/QONE_APP_MEDIA_ROUTING]";

export function createAppMediaTools(service: AppMediaService, workspacePath: string): ToolDefinition[] {
  return [{
    name: "qone_app_inspect", label: "App · inspect media", description: "Inspect one clearly identified TikTok, Bilibili, YouTube, X or Reddit media URL using the saved local login session when needed. A normal X or Reddit post is not enough reason to use this tool; use qone_opencli_run for social content. For Bilibili video analysis, inspect metadata here, then use qone_video_download and qone_video_use_file.",
    promptSnippet: APP_MEDIA_ROUTING_GUIDANCE, parameters: Type.Object({ app: appType, url: Type.String({ minLength: 1 }) }),
    execute: async (_id, params, _signal) => ({ content: [{ type: "text", text: JSON.stringify(await service.inspect((params as { app: MediaAppId }).app, (params as { url: string }).url)) }], details: {} }),
  }, {
    name: "qone_app_list", label: "App · list profile media", description: "List media works from a TikTok, Bilibili, YouTube, X or Reddit profile/channel URL when the user wants media items for downloading. Use qone_opencli_discover and qone_opencli_run for profile, posts, comments, account pages, or other site operations. Telegram requires separate TDLib setup.",
    parameters: Type.Object({ app: appType, url: Type.String({ minLength: 1 }), limit: Type.Integer({ minimum: 1, maximum: 100 }) }),
    execute: async (_id, params, _signal) => { const input = params as { app: MediaAppId; url: string; limit: number }; const result = await service.list(input.app, input.url, input.limit, _signal); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: result.completion !== "limit" && result.completion !== "exhausted" }; },
  }, {
    name: "qone_app_download", label: "App · save media", description: "Save one TikTok, Bilibili, YouTube, X or Reddit work to a workspace directory. Use qone_video_download instead when the goal is to analyze or summarize a video. The embedded route runs first; Bilibili OpenCLI fallback is internal and can run only after that download route actually fails. Telegram is enabled after its TDLib account setup.",
    parameters: Type.Object({ app: appType, url: Type.String({ minLength: 1 }), mode: Type.Optional(Type.Union([Type.Literal("video"), Type.Literal("audio"), Type.Literal("subtitles")])), languages: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { maxItems: 20 })), path: Type.Optional(Type.String({ minLength: 1 })) }),
    execute: async (_id, params, signal) => {
      const input = params as { app: MediaAppId; url: string; mode?: MediaAppMode; languages?: string[]; path?: string };
      const destination = path.resolve(workspacePath, input.path?.trim() || path.join("downloads", input.app));
      await mkdir(destination, { recursive: true });
      let result;
      try {
        result = await service.download(input.app, input.url, input.mode ?? "video", input.languages, signal);
      } catch (error) {
        if (input.app !== "bilibili" || signal?.aborted || (input.mode ?? "video") !== "video") throw error;
        let fallback;
        try { fallback = await downloadBilibiliOpenCli(input.url, signal); }
        catch (fallbackError) { throw runtimeError("media-tool.video_retrieval_failed_yt_dlp_bilibili_cli_opencli_fallback", { p0: String(error), p1: String(fallbackError) }); }
        try {
          const id = fallback.id ?? mediaAppContentId("bilibili", input.url) ?? "bilibili-video";
          const saved: string[] = [];
          for (const [index, file] of fallback.files.entries()) {
            const extension = path.extname(file.path) || ".bin";
            const target = path.join(destination, `${id}${fallback.files.length > 1 ? `-${index + 1}` : ""}${extension}`);
            try { await copyFile(file.path, target, 1); saved.push(target); }
            catch (copyError) { if ((copyError as NodeJS.ErrnoException).code === "EEXIST") throw runtimeError("app-media.invalid_output"); throw copyError; }
          }
          return { content: [{ type: "text", text: JSON.stringify({ app: input.app, id, directory: destination, files: saved, source: "OpenCLI fallback" }) }], details: { app: input.app, id, directory: destination, files: saved, source: "OpenCLI fallback" } };
        } finally { await rm(fallback.directory, { recursive: true, force: true }); }
      }
      const saved: string[] = [];
      try {
        for (const [index, file] of result.files.entries()) {
          const extension = path.extname(file.path) || ".bin";
          const stem = `${result.item.id}${result.files.length > 1 ? `-${index + 1}` : ""}`;
          const target = path.join(destination, `${stem}${extension}`);
          try { await copyFile(file.path, target, 1); saved.push(target); }
          catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw runtimeError("app-media.invalid_output"); throw error; }
        }
        const output = { ...result.item, app: input.app, directory: destination, files: saved };
        return { content: [{ type: "text", text: JSON.stringify(output) }], details: output };
      } finally { await rm(result.directory, { recursive: true, force: true }); }
    },
  }];
}
