import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MessageAttachmentInfo, ModelConfigInfo } from "@qone/protocol";
import { Type } from "typebox";
import { mkdtemp, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isBilibiliUrl, readBilibiliFallback } from "./bilibili-fallback.js";
import { localMediaMarker, youtubeUrlsFromText } from "./google-media.js";
import { configuredCapabilities } from "./media-capabilities.js";
import { videoAttachmentsAsAudio } from "./media-attachments.js";
import { extractVideoFrames, videoAttachmentFrames, videoDuration } from "./video-frames.js";
import { downloadAudio, downloadVideo, extractVideoAudio, mediaMimeType } from "./video-download.js";

export interface MediaToolOptions {
  active: () => { runId: string; model: { provider: string; id: string; api: string } } | undefined;
  configs: () => readonly ModelConfigInfo[];
  registerMedia: (runId: string, path: string, mimeType: string, directory?: string) => void;
  registerDirectory?: (runId: string, directory: string) => void;
  isTemporary?: (runId: string, filePath: string) => boolean;
  hasMedia?: (runId: string, filePath: string) => boolean;
  attachment?: (runId: string, attachmentId: string) => MessageAttachmentInfo | undefined;
}

function supportsFrameVideo(model: { api: string; provider: string; id: string }, input: readonly string[]): boolean {
  return model.api !== "google-generative-ai" && input.includes("video") && input.includes("image");
}

function supportsAudioInput(model: { api: string }, input: readonly string[]): boolean {
  return input.includes("audio") && (model.api === "google-generative-ai" || model.api === "openai-completions");
}

function supportsVideoInput(model: { api: string; provider: string; id: string }, input: readonly string[]): boolean {
  return model.api === "google-generative-ai" && input.includes("video") || supportsFrameVideo(model, input);
}

async function frameResult(filePath: string, source: string, options: MediaToolOptions, runId: string, timestamps?: number[], signal?: AbortSignal) {
  if (!timestamps) {
    const duration = await videoDuration(filePath, signal);
    return { content: [{ type: "text" as const, text: `已通过 ${source} 获取视频。本地文件：${filePath}。${duration === undefined ? "视频时长未知" : `视频时长 ${duration} 秒`}。按任务需要选择时间点，再调用 qone_video_use_file，传 path 和 timestamps（秒）读取画面；需要声音时对相同路径设置 mode=audio。当前尚未读取画面或声音。` }],
      details: { source, path: filePath, videoRead: false, transport: "image-frames", duration } };
  }
  const frames = await extractVideoFrames(filePath, timestamps, signal);
  options.registerDirectory?.(runId, frames.directory);
  return {
    content: [{ type: "text" as const, text: `已通过 ${source} 获取视频并按所选时间点读取 ${frames.frames.length} 帧。模型实际读取的是这些静态画面，不是完整视频，也未读取声音。本地文件：${filePath}。需要声音时可对这个路径调用 qone_video_use_file 并设置 mode=audio；无需重新下载。` },
      ...frames.frames.flatMap(({ seconds, image }) => [{ type: "text" as const, text: `画面时间：${seconds} 秒` }, image])],
    details: { source, path: filePath, videoRead: true, transport: "image-frames", frameCount: frames.frames.length },
  };
}

export function createAttachmentAudioTool(options: MediaToolOptions): ToolDefinition {
  return {
    name: "qone_media_extract_audio",
    label: "Media · extract sound from attachment",
    description: "Only when the task needs the sound of a user-attached video and this agent has audio input: use the attachmentId in runtime-video-attachments to extract its sound. The original local file is read in place. This does not read video frames; delegate the original attachment when the task needs the picture.",
    parameters: Type.Object({ attachmentId: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params, signal) => {
      const active = options.active();
      if (!active) throw new Error("没有可用的媒体识别任务");
      const { runId, model } = active;
      const input = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`).input;
      if (!input.includes("audio")) throw new Error("当前模型未配置音频输入；请委派原始附件");
      if (model.api !== "google-generative-ai" && model.api !== "openai-completions") {
        throw new Error("当前 API 格式尚未接入音频附件输入；请委派原始附件");
      }
      const attachmentId = (params as { attachmentId: string }).attachmentId;
      const attachment = options.attachment?.(runId, attachmentId);
      if (!attachment || !attachment.mimeType.startsWith("video/")) throw new Error("未找到当前任务的视频附件引用");
      const registerDirectory = options.registerDirectory;
      if (!registerDirectory) throw new Error("音轨提取的临时文件管理尚未初始化");
      const [audio] = await videoAttachmentsAsAudio([attachment], (directory) => registerDirectory(runId, directory), signal) ?? [];
      if (!audio?.localPath) throw new Error("无法从视频附件提取音轨");
      options.registerMedia(runId, audio.localPath, audio.mimeType);
      return { content: [{ type: "text", text: `已从用户视频附件提取声音；未读取画面。音频输入：${localMediaMarker(audio.localPath, audio.mimeType, true)}` }],
        details: { path: audio.localPath, mimeType: audio.mimeType, videoRead: false } };
    },
  };
}

export function createAttachmentFrameTool(options: MediaToolOptions): ToolDefinition {
  return {
    name: "qone_media_extract_frames",
    label: "Media · read video picture frames",
    description: "Read a user-attached video's duration first, then call again with task-relevant timestamps in seconds to read those picture frames. Use its attachmentId from runtime-video-attachments. Requires configured video and image input. The original file stays in place. This does not read sound or the complete video.",
    parameters: Type.Object({ attachmentId: Type.String({ minLength: 1 }), timestamps: Type.Optional(Type.Array(Type.Number({ minimum: 0 }))) }),
    execute: async (_toolCallId, params, signal) => {
      const active = options.active();
      if (!active) throw new Error("没有可用的媒体识别任务");
      const { runId, model } = active;
      const input = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`).input;
      if (!supportsFrameVideo(model, input)) throw new Error("当前模型无法通过图像协议读取视频画面；请委派原始附件");
      const request = params as { attachmentId: string; timestamps?: number[] };
      const attachment = options.attachment?.(runId, request.attachmentId);
      if (!attachment || !attachment.mimeType.startsWith("video/")) throw new Error("未找到当前任务的视频附件引用");
      if (!options.registerDirectory) throw new Error("画面提取的临时文件管理尚未初始化");
      const prepared = await videoAttachmentFrames(attachment, request.timestamps, (directory) => options.registerDirectory!(runId, directory), signal);
      return {
        content: [{ type: "text" as const, text: request.timestamps ? `已从附件 ${attachment.name} 按指定时间点读取 ${prepared.frames.length} 帧；未读取声音或完整视频。` : `附件 ${attachment.name}：${prepared.duration === undefined ? "视频时长未知" : `视频时长 ${prepared.duration} 秒`}。请按任务需要选择时间点，带 timestamps（秒）再次调用本工具。当前未读取画面或声音。` },
          ...prepared.frames.flatMap(({ seconds, image }) => [{ type: "text" as const, text: `画面时间：${seconds} 秒` }, image])],
        details: { source: "user attachment", videoRead: Boolean(request.timestamps), transport: "image-frames", frameCount: prepared.frames.length, duration: prepared.duration },
      };
    },
  };
}

export function createVideoDownloadTool(options: MediaToolOptions): ToolDefinition {
  return {
    name: "qone_video_download",
    label: "Video · download for recognition",
    description: "Get an online video or its audio for this agent's own recognition. Set mode=audio when only sound is needed. Non-Gemini visual input returns the local path and duration; call qone_video_use_file with relevant timestamps to read still frames. Tries yt-dlp for every site. If Bilibili fails, falls back to clearly labeled subtitles/audio/metadata from bilibili-cli and then OpenCLI data adapters; it does not claim to have read the full video. For other sites, use qone_video_staging_dir, a site-specific OpenCLI or web download, and qone_video_use_file. Gemini reads YouTube URLs directly when video input is configured. Never download before delegating to another agent.",
    promptSnippet: "When you are configured to read video or audio and need to inspect an online video URL yourself, call qone_video_download; set mode=audio if the task needs only sound. Gemini with video input can read YouTube links directly. Bilibili failure returns clearly labeled bilibili-cli or OpenCLI data and does not prove full video recognition. If another site's download fails, use OpenCLI or the website to save into a qone_video_staging_dir, then qone_video_use_file. If your model lacks the needed capability, delegate the original URL instead.",
    parameters: Type.Object({ url: Type.String({ minLength: 1 }), mode: Type.Optional(Type.Union([Type.Literal("video"), Type.Literal("audio")])) }),
    execute: async (_toolCallId, params, signal) => {
      const active = options.active();
      if (!active) throw new Error("没有可用的视频识别任务");
      const { runId, model } = active;
      const capability = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`);
      const request = params as { url: string; mode?: "video" | "audio" };
      const mode = request.mode ?? (capability.input.includes("video") ? "video" : "audio");
      if (mode === "video" && !supportsVideoInput(model, capability.input)) {
        throw new Error("当前 API 格式无法读取完整视频或画面帧；需要画面时请配置图像输入，或委派原始链接");
      }
      if (mode === "audio" && !supportsAudioInput(model, capability.input)) {
        throw new Error("当前模型或 API 格式无法读取音频；请委派原始链接");
      }
      const url = request.url.trim();
      if (model.api === "google-generative-ai" && youtubeUrlsFromText(url).includes(url) && mode === "video") throw new Error("Gemini 可直接识别 YouTube 链接，无需下载");
      let downloaded: Awaited<ReturnType<typeof downloadVideo>>;
      let source = "yt-dlp";
      try {
        if (mode === "audio") {
          try {
            downloaded = await downloadAudio(url, signal);
          } catch (audioError) {
            if (signal?.aborted) throw audioError;
            downloaded = await downloadVideo(url, signal).catch((videoError) => {
              throw new Error(`音轨下载失败：${String(audioError)}；完整视频下载失败：${String(videoError)}`);
            });
          }
        } else downloaded = await downloadVideo(url, signal);
      } catch (error) {
        if (signal?.aborted || !isBilibiliUrl(url)) throw error;
        const fallback = await readBilibiliFallback(url, signal).catch((fallbackError) => {
          throw new Error(`视频获取失败：yt-dlp: ${String(error)}；bilibili-cli/OpenCLI 降级资料: ${String(fallbackError)}`);
        });
        const parts = [`降级分析：未取得完整视频，不能声称识别了画面。资料来源：${fallback.source}。`, fallback.text];
        if (fallback.audio) {
          options.registerMedia(runId, fallback.audio.path, fallback.audio.mimeType, fallback.audio.directory);
          parts.push(`可用音频路径：${fallback.audio.path}`);
          if (supportsAudioInput(model, capability.input)) parts.push(`音频输入：${localMediaMarker(fallback.audio.path, fallback.audio.mimeType, true)}`);
          else parts.push("当前模型未配置音频输入；需要声音分析时委派音频子代理并传 mediaPath。");
        } else parts.push("未取得可读取的音频文件。");
        return { content: [{ type: "text", text: parts.join("\n\n") }], details: { source: fallback.source, degraded: true, hasAudio: Boolean(fallback.audio) } };
      }
      options.registerMedia(runId, downloaded.path, downloaded.mimeType, downloaded.directory);
      if (mode === "video" && supportsFrameVideo(model, capability.input)) return frameResult(downloaded.path, source, options, runId, undefined, signal);
      if (mode === "audio") {
        const audio = downloaded.mimeType.startsWith("audio/") ? downloaded : await extractVideoAudio(downloaded.path, signal);
        if (audio !== downloaded) options.registerMedia(runId, audio.path, audio.mimeType, audio.directory);
        return { content: [{ type: "text", text: `已通过 ${source} ${audio === downloaded ? "直接获取音频" : "获取视频并提取音频"}；未读取画面。音频路径：${audio.path}\n音频输入：${localMediaMarker(audio.path, audio.mimeType, true)}` }],
          details: { source, path: audio.path, mimeType: audio.mimeType, videoRead: false } };
      }
      return { content: [{ type: "text", text: `已通过 ${source} 下载视频，本地路径：${downloaded.path}\n媒体输入：${localMediaMarker(downloaded.path, downloaded.mimeType, true)}\n实际来源：完整视频文件。` }],
        details: { source, path: downloaded.path, mimeType: downloaded.mimeType } };
    },
  };
}

/** Connect a site-specific OpenCLI or web download to the same native media path. */
export function createVideoFallbackTools(options: MediaToolOptions): ToolDefinition[] {
  return [{
    name: "qone_video_staging_dir",
    label: "Video · prepare download directory",
    description: "Create a temporary directory for an OpenCLI or website video download after yt-dlp fails. Give this directory to the site's download command; Qone cleans it when this run ends.",
    parameters: Type.Object({}),
    execute: async () => {
      const active = options.active();
      if (!active) throw new Error("没有可用的媒体识别任务");
      const input = configuredCapabilities(options.configs(), `${active.model.provider}/${active.model.id}`).input;
      if (!supportsVideoInput(active.model, input) && !supportsAudioInput(active.model, input)) {
        throw new Error("当前模型无法处理视频或音频；请委派原始链接，勿提前下载");
      }
      const directory = await mkdtemp(path.join(tmpdir(), "qone-video-fallback-"));
      options.registerDirectory?.(active.runId, directory);
      return { content: [{ type: "text", text: `临时下载目录：${directory}。下载完成后调用 qone_video_use_file，传入实际媒体文件路径。` }], details: { directory } };
    },
  }, {
    name: "qone_video_use_file",
    label: "Video · use downloaded file",
    description: "Use a media file from this run. For non-Gemini video input, first call without timestamps to read duration, then select relevant timestamps in seconds to read those still frames. Set mode=audio to extract sound from the same file. Gemini receives the full file. User files outside Qone's temporary directory are never deleted.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }), mode: Type.Optional(Type.Union([Type.Literal("video"), Type.Literal("audio")])), timestamps: Type.Optional(Type.Array(Type.Number({ minimum: 0 }))) }),
    execute: async (_toolCallId, params, signal) => {
      const active = options.active();
      if (!active) throw new Error("没有可用的媒体识别任务");
      const { runId, model } = active;
      const input = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`).input;
      if (!input.includes("video") && !input.includes("audio")) throw new Error("当前模型无法处理视频或音频；请委派原始链接，勿提前下载");
      const request = params as { path: string; mode?: "video" | "audio"; timestamps?: number[] };
      const filePath = request.path;
      if (!path.isAbsolute(filePath)) throw new Error("需要媒体文件的绝对路径");
      const info = await stat(filePath);
      if (!info.isFile()) throw new Error("媒体路径不是文件");
      const mimeType = mediaMimeType(filePath);
      if (!mimeType) throw new Error("无法识别媒体文件格式");
      const mode = request.mode ?? (mimeType.startsWith("audio/") || !input.includes("video") ? "audio" : "video");
      if (mode === "video" && !mimeType.startsWith("video/")) throw new Error("mode=video 需要视频文件；当前路径是音频文件");
      if (mode === "audio" && !/^(?:audio|video)\//.test(mimeType)) throw new Error("mode=audio 需要音频或视频文件");
      if (mode === "video" && !supportsVideoInput(model, input)) throw new Error("当前 API 格式无法读取完整视频或画面帧；请配置图像输入或委派原始附件");
      if (mode === "audio" && !supportsAudioInput(model, input)) throw new Error("当前模型或 API 格式无法读取音频；请委派原始附件");
      const temporary = options.isTemporary?.(runId, filePath) ?? false;
      if (!temporary && !options.hasMedia?.(runId, filePath)) {
        throw new Error("媒体文件必须位于当前任务的临时下载目录，或由当前任务的下载工具生成");
      }
      options.registerMedia(runId, filePath, mimeType);
      if (mode === "video" && supportsFrameVideo(model, input) && mimeType.startsWith("video/")) return frameResult(filePath, "local download", options, runId, request.timestamps, signal);
      if (mimeType.startsWith("video/") && mode === "audio") {
        const audio = await extractVideoAudio(filePath, signal);
        options.registerMedia(runId, audio.path, audio.mimeType, audio.directory);
        return { content: [{ type: "text", text: `已从文件提取音频，未读取画面。音频输入：${localMediaMarker(audio.path, audio.mimeType, true)}` }],
          details: { source: "local download", path: audio.path, mimeType: audio.mimeType, videoRead: false } };
      }
      const capability = mimeType.startsWith("video/") ? "video" : "audio";
      if (!input.includes(capability)) return { content: [{ type: "text", text: `当前模型未配置${capability === "video" ? "视频" : "音频"}输入；请用 mediaPath=${filePath} 委派合适的子代理。` }], details: { path: filePath, mimeType, delegated: true } };
      return { content: [{ type: "text", text: `实际来源：本地下载文件 ${filePath}。媒体输入：${localMediaMarker(filePath, mimeType, temporary)}` }],
        details: { source: "local download", path: filePath, mimeType } };
    },
  }];
}
