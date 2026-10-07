import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { MEDIA_APP_IDS, mediaAppContentId, type MediaAppId, type MediaAppMode } from "@qone/protocol";
import { copyFile, mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { Type } from "typebox";
import type { AppMediaService } from "./app-media-service.js";
import { downloadBilibiliOpenCli } from "./bilibili-fallback.js";
import type { EmbeddedOpenCliRunner } from "./browser-sync.js";
import { runtimeError } from "./runtime-localization.js";

const appType = Type.Union(MEDIA_APP_IDS.map((app) => Type.Literal(app)));

export function createAppMediaTools(service: AppMediaService, workspacePath: string, openCli: EmbeddedOpenCliRunner): ToolDefinition[] {
  return [{
    name: "qone_app_inspect", label: "App · inspect media", description: "Inspect one identified media URL through the selected media application and return structured metadata.",
    parameters: Type.Object({ app: appType, url: Type.String({ minLength: 1 }) }),
    execute: async (_id, params, _signal) => ({ content: [{ type: "text", text: JSON.stringify(await service.inspect((params as { app: MediaAppId }).app, (params as { url: string }).url)) }], details: {} }),
  }, {
    name: "qone_app_list", label: "App · list profile media", description: "List media items from a creator, channel, profile, or collection URL when the user asks for a media batch.",
    parameters: Type.Object({ app: appType, url: Type.String({ minLength: 1 }), limit: Type.Integer({ minimum: 1, maximum: 100 }) }),
    execute: async (_id, params, _signal) => { const input = params as { app: MediaAppId; url: string; limit: number }; const result = await service.list(input.app, input.url, input.limit, _signal); return { content: [{ type: "text", text: JSON.stringify(result) }], details: result, isError: result.completion !== "limit" && result.completion !== "exhausted" }; },
  }, {
    name: "qone_app_download", label: "App · save media", description: "Save one media item to a workspace directory. Use qone_video_download when the goal is model analysis rather than a persistent copy.",
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
        try { fallback = await downloadBilibiliOpenCli(input.url, signal, openCli); }
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
