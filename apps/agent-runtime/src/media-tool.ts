import { runtimeText, runtimeError } from "./runtime-localization";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MessageAttachmentInfo, ModelConfigInfo } from "@qone/protocol";
import { Type } from "typebox";
import { mkdtemp, stat } from "node:fs/promises";
import { qoneTemporaryDir } from "@qone/shared";
import path from "node:path";
import { downloadBilibiliOpenCli, isBilibiliUrl, readBilibiliFallback } from "./bilibili-fallback.js";
import { localMediaMarker, youtubeUrlsFromText } from "./google-media.js";
import { configuredCapabilities } from "./media-capabilities.js";
import { videoAttachmentsAsAudio } from "./media-attachments.js";
import { extractVideoFrames, videoAttachmentFrames, videoDuration } from "./video-frames.js";
import { downloadAudio, downloadVideo, extractVideoAudio, mediaMimeType } from "./video-download.js";
import { isDouyinUrl } from "./douyin-bridge.js";
import type { EmbeddedOpenCliRunner } from "./browser-sync.js";

export interface MediaToolOptions {
  active: () => { runId: string; model: { provider: string; id: string; api: string } } | undefined;
  configs: () => readonly ModelConfigInfo[];
  registerMedia: (runId: string, path: string, mimeType: string, directory?: string) => void;
  registerDirectory?: (runId: string, directory: string) => void;
  isTemporary?: (runId: string, filePath: string) => boolean;
  hasMedia?: (runId: string, filePath: string) => boolean;
  douyinDownload?: (url: string, signal?: AbortSignal) => Promise<Awaited<ReturnType<typeof downloadVideo>>>;
  bilibiliDownload?: (url: string, mode: "video" | "audio", signal?: AbortSignal) => Promise<Awaited<ReturnType<typeof downloadVideo>>>;
  openCli?: EmbeddedOpenCliRunner;
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
    return { content: [{ type: "text" as const, text: runtimeText("media-tool.video_retrieved_through_local_file_choose_timestamps_as_needed", { p0: source, p1: filePath, p2: duration === undefined ? runtimeText("media-tool.video_duration_unknown") : runtimeText("media-tool.video_duration_seconds", { p0: duration }) }) }],
      details: { source, path: filePath, videoRead: false, transport: "image-frames", duration } };
  }
  const frames = await extractVideoFrames(filePath, timestamps, signal);
  options.registerDirectory?.(runId, frames.directory);
  return {
    content: [{ type: "text" as const, text: runtimeText("media-tool.video_retrieved_through_frames_read_at_the_selected_timestamps", { p0: source, p1: frames.frames.length, p2: filePath }) },
      ...frames.frames.flatMap(({ seconds, image }) => [{ type: "text" as const, text: runtimeText("media-tool.frame_timestamp_seconds", { p0: seconds }) }, image])],
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
      if (!active) throw runtimeError("media-tool.no_media_recognition_task_is_available", {});
      const { runId, model } = active;
      const input = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`).input;
      if (!input.includes("audio")) throw runtimeError("media-tool.the_current_model_has_no_audio_input_configured_delegate", {});
      if (model.api !== "google-generative-ai" && model.api !== "openai-completions") {
        throw runtimeError("media-tool.the_current_api_format_does_not_support_audio_attachments", {});
      }
      const attachmentId = (params as { attachmentId: string }).attachmentId;
      const attachment = options.attachment?.(runId, attachmentId);
      if (!attachment || !attachment.mimeType.startsWith("video/")) throw runtimeError("media-tool.no_video_attachment_reference_was_found_for_the_current", {});
      const registerDirectory = options.registerDirectory;
      if (!registerDirectory) throw runtimeError("media-tool.temporary_file_management_for_audio_extraction_is_not_initialized", {});
      const [audio] = await videoAttachmentsAsAudio([attachment], (directory) => registerDirectory(runId, directory), signal) ?? [];
      if (!audio?.localPath) throw runtimeError("media-tool.could_not_extract_audio_from_the_video_attachment", {});
      options.registerMedia(runId, audio.localPath, audio.mimeType);
      return { content: [{ type: "text", text: runtimeText("media-tool.audio_extracted_from_the_user_s_video_attachment_no", { p0: localMediaMarker(audio.localPath, audio.mimeType, true) }) }],
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
      if (!active) throw runtimeError("media-tool.no_media_recognition_task_is_available", {});
      const { runId, model } = active;
      const input = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`).input;
      if (!supportsFrameVideo(model, input)) throw runtimeError("media-tool.the_current_model_cannot_read_video_frames_through_the", {});
      const request = params as { attachmentId: string; timestamps?: number[] };
      const attachment = options.attachment?.(runId, request.attachmentId);
      if (!attachment || !attachment.mimeType.startsWith("video/")) throw runtimeError("media-tool.no_video_attachment_reference_was_found_for_the_current", {});
      if (!options.registerDirectory) throw runtimeError("media-tool.temporary_file_management_for_frame_extraction_is_not_initialized", {});
      const prepared = await videoAttachmentFrames(attachment, request.timestamps, (directory) => options.registerDirectory!(runId, directory), signal);
      return {
        content: [{ type: "text" as const, text: request.timestamps ? runtimeText("media-tool.read_frames_from_attachment_at_the_specified_timestamps_no", { p0: attachment.name, p1: prepared.frames.length }) : runtimeText("media-tool.attachment_choose_timestamps_as_needed_and_call_this_tool", { p0: attachment.name, p1: prepared.duration === undefined ? runtimeText("media-tool.video_duration_unknown") : runtimeText("media-tool.video_duration_seconds", { p0: prepared.duration }) }) },
          ...prepared.frames.flatMap(({ seconds, image }) => [{ type: "text" as const, text: runtimeText("media-tool.frame_timestamp_seconds", { p0: seconds }) }, image])],
        details: { source: "user attachment", videoRead: Boolean(request.timestamps), transport: "image-frames", frameCount: prepared.frames.length, duration: prepared.duration },
      };
    },
  };
}

export function createVideoDownloadTool(options: MediaToolOptions): ToolDefinition {
  return {
    name: "qone_video_download",
    label: "Video · download for recognition",
    description: "Get an online video or its audio for this agent's own recognition. Set mode=audio when only sound is needed. Non-Gemini visual input returns the local path and duration; call qone_video_use_file with relevant timestamps to read still frames. Try Qone's embedded session or page route first: Douyin uses the signed in-page bridge, Bilibili uses its saved Qone session, and other sites use yt-dlp. If the embedded route fails, use the site's OpenCLI or web download as a labeled fallback. Gemini reads YouTube URLs directly when video input is configured. Never download before delegating to another agent.",
    promptSnippet: "When you are configured to read video or audio and need to inspect an online video URL yourself, call qone_video_download; set mode=audio if the task needs only sound. Always try Qone's embedded route first. Douyin downloads use the signed in-page bridge; Bilibili downloads use Qone's saved Bilibili session and yt-dlp. Only after that route fails, use the site's OpenCLI or website to save into a qone_video_staging_dir, then qone_video_use_file. Gemini with video input can read YouTube links directly. If your model lacks the needed capability, delegate the original URL instead.",
    parameters: Type.Object({ url: Type.String({ minLength: 1 }), mode: Type.Optional(Type.Union([Type.Literal("video"), Type.Literal("audio")])) }),
    execute: async (_toolCallId, params, signal) => {
      const active = options.active();
      if (!active) throw runtimeError("media-tool.no_video_recognition_task_is_available", {});
      const { runId, model } = active;
      const capability = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`);
      const request = params as { url: string; mode?: "video" | "audio" };
      const mode = request.mode ?? (capability.input.includes("video") ? "video" : "audio");
      if (mode === "video" && !supportsVideoInput(model, capability.input)) {
        throw runtimeError("media-tool.the_current_api_format_cannot_read_full_videos_or", {});
      }
      if (mode === "audio" && !supportsAudioInput(model, capability.input)) {
        throw runtimeError("media-tool.the_current_model_or_api_format_cannot_read_audio", {});
      }
      const url = request.url.trim();
      if (model.api === "google-generative-ai" && youtubeUrlsFromText(url).includes(url) && mode === "video") throw runtimeError("media-tool.gemini_can_recognize_youtube_urls_directly_no_download_is", {});
      let downloaded: Awaited<ReturnType<typeof downloadVideo>>;
      let source = "yt-dlp";
      if (isDouyinUrl(url)) {
        if (!options.douyinDownload) throw runtimeError("media-tool.douyin_page_bridge_not_connected", {});
        downloaded = await options.douyinDownload(url, signal);
        source = "抖音页面桥接";
      } else try {
        if (isBilibiliUrl(url) && options.bilibiliDownload) {
          downloaded = await options.bilibiliDownload(url, mode, signal);
          source = "哔哩哔哩 yt-dlp";
        } else {
          if (mode === "audio") {
            try {
              downloaded = await downloadAudio(url, signal);
            } catch (audioError) {
              if (signal?.aborted) throw audioError;
              downloaded = await downloadVideo(url, signal).catch((videoError) => {
                throw runtimeError("media-tool.audio_download_failed_full_video_download_failed", { p0: String(audioError), p1: String(videoError) });
              });
            }
          } else downloaded = await downloadVideo(url, signal);
        }
      } catch (error) {
        if (signal?.aborted || !isBilibiliUrl(url)) throw error;
        try {
          if (!options.openCli) throw new Error("Built-in OpenCLI browser is unavailable");
          const fallbackVideo = await downloadBilibiliOpenCli(url, signal, options.openCli);
          downloaded = fallbackVideo.files[0]!;
          source = "哔哩哔哩 OpenCLI 兜底";
        } catch (downloadFallbackError) {
          if (!options.openCli) throw new Error("Built-in OpenCLI browser is unavailable");
          const fallback = await readBilibiliFallback(url, signal, options.openCli).catch((fallbackError) => {
            throw runtimeError("media-tool.video_retrieval_failed_yt_dlp_bilibili_cli_opencli_fallback", { p0: String(error), p1: `${String(downloadFallbackError)}; ${String(fallbackError)}` });
          });
          const parts = [runtimeText("media-tool.fallback_analysis_the_full_video_was_not_retrieved_do", { p0: fallback.source }), fallback.text];
          if (fallback.audio) {
            options.registerMedia(runId, fallback.audio.path, fallback.audio.mimeType, fallback.audio.directory);
            parts.push(runtimeText("media-tool.available_audio_path", { p0: fallback.audio.path }));
            if (supportsAudioInput(model, capability.input)) parts.push(runtimeText("media-tool.audio_input", { p0: localMediaMarker(fallback.audio.path, fallback.audio.mimeType, true) }));
            else parts.push(runtimeText("media-tool.the_current_model_has_no_audio_input_configured_delegate_details_0"));
          } else parts.push(runtimeText("media-tool.no_readable_audio_file_was_retrieved"));
          return { content: [{ type: "text", text: parts.join("\n\n") }], details: { source: fallback.source, degraded: true, hasAudio: Boolean(fallback.audio) } };
        }
      }
      options.registerMedia(runId, downloaded.path, downloaded.mimeType, downloaded.directory);
      if (mode === "video" && supportsFrameVideo(model, capability.input)) return frameResult(downloaded.path, source, options, runId, undefined, signal);
      if (mode === "audio") {
        const audio = downloaded.mimeType.startsWith("audio/") ? downloaded : await extractVideoAudio(downloaded.path, signal);
        if (audio !== downloaded) options.registerMedia(runId, audio.path, audio.mimeType, audio.directory);
        return { content: [{ type: "text", text: runtimeText("media-tool.used_to_no_frames_have_been_read_audio_path", { p0: source, p1: audio === downloaded ? runtimeText("media-tool.retrieve_audio_directly") : runtimeText("media-tool.retrieve_the_video_and_extract_audio"), p2: audio.path, p3: localMediaMarker(audio.path, audio.mimeType, true) }) }],
          details: { source, path: audio.path, mimeType: audio.mimeType, videoRead: false } };
      }
      return { content: [{ type: "text", text: runtimeText("media-tool.video_downloaded_through_local_path_media_input_actual_source", { p0: source, p1: downloaded.path, p2: localMediaMarker(downloaded.path, downloaded.mimeType, true) }) }],
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
      if (!active) throw runtimeError("media-tool.no_media_recognition_task_is_available", {});
      const input = configuredCapabilities(options.configs(), `${active.model.provider}/${active.model.id}`).input;
      if (!supportsVideoInput(active.model, input) && !supportsAudioInput(active.model, input)) {
        throw runtimeError("media-tool.the_current_model_cannot_process_video_or_audio_delegate", {});
      }
      const directory = await mkdtemp(path.join(qoneTemporaryDir(), "qone-video-fallback-"));
      options.registerDirectory?.(active.runId, directory);
      return { content: [{ type: "text", text: runtimeText("media-tool.temporary_download_directory_after_downloading_call_qone_video_use", { p0: directory }) }], details: { directory } };
    },
  }, {
    name: "qone_video_use_file",
    label: "Video · use downloaded file",
    description: "Use a media file from this run. For non-Gemini video input, first call without timestamps to read duration, then select relevant timestamps in seconds to read those still frames. Set mode=audio to extract sound from the same file. Gemini receives the full file. User files outside Qone's temporary directory are never deleted.",
    parameters: Type.Object({ path: Type.String({ minLength: 1 }), mode: Type.Optional(Type.Union([Type.Literal("video"), Type.Literal("audio")])), timestamps: Type.Optional(Type.Array(Type.Number({ minimum: 0 }))) }),
    execute: async (_toolCallId, params, signal) => {
      const active = options.active();
      if (!active) throw runtimeError("media-tool.no_media_recognition_task_is_available", {});
      const { runId, model } = active;
      const input = configuredCapabilities(options.configs(), `${model.provider}/${model.id}`).input;
      if (!input.includes("video") && !input.includes("audio")) throw runtimeError("media-tool.the_current_model_cannot_process_video_or_audio_delegate", {});
      const request = params as { path: string; mode?: "video" | "audio"; timestamps?: number[] };
      const filePath = request.path;
      if (!path.isAbsolute(filePath)) throw runtimeError("media-tool.an_absolute_media_file_path_is_required", {});
      const info = await stat(filePath);
      if (!info.isFile()) throw runtimeError("media-tool.the_media_path_is_not_a_file", {});
      const mimeType = mediaMimeType(filePath);
      if (!mimeType) throw runtimeError("media-tool.could_not_identify_the_media_file_format", {});
      const mode = request.mode ?? (mimeType.startsWith("audio/") || !input.includes("video") ? "audio" : "video");
      if (mode === "video" && !mimeType.startsWith("video/")) throw runtimeError("media-tool.mode_video_requires_a_video_file_the_current_path", {});
      if (mode === "audio" && !/^(?:audio|video)\//.test(mimeType)) throw runtimeError("media-tool.mode_audio_requires_an_audio_or_video_file", {});
      if (mode === "video" && !supportsVideoInput(model, input)) throw runtimeError("media-tool.the_current_api_format_cannot_read_full_videos_or_details_0", {});
      if (mode === "audio" && !supportsAudioInput(model, input)) throw runtimeError("media-tool.the_current_model_or_api_format_cannot_read_audio_details_0", {});
      const temporary = options.isTemporary?.(runId, filePath) ?? false;
      if (!temporary && !options.hasMedia?.(runId, filePath)) {
        throw runtimeError("media-tool.the_media_file_must_be_in_the_current_task", {});
      }
      options.registerMedia(runId, filePath, mimeType);
      if (mode === "video" && supportsFrameVideo(model, input) && mimeType.startsWith("video/")) return frameResult(filePath, "local download", options, runId, request.timestamps, signal);
      if (mimeType.startsWith("video/") && mode === "audio") {
        const audio = await extractVideoAudio(filePath, signal);
        options.registerMedia(runId, audio.path, audio.mimeType, audio.directory);
        return { content: [{ type: "text", text: runtimeText("media-tool.audio_extracted_from_the_file_no_frames_have_been", { p0: localMediaMarker(audio.path, audio.mimeType, true) }) }],
          details: { source: "local download", path: audio.path, mimeType: audio.mimeType, videoRead: false } };
      }
      const capability = mimeType.startsWith("video/") ? "video" : "audio";
      if (!input.includes(capability)) return { content: [{ type: "text", text: runtimeText("media-tool.the_current_model_has_no_input_configured_delegate_to", { p0: capability === "video" ? runtimeText("media-tool.video") : runtimeText("media-tool.audio"), p1: filePath }) }], details: { path: filePath, mimeType, delegated: true } };
      return { content: [{ type: "text", text: runtimeText("media-tool.actual_source_local_downloaded_file_media_input", { p0: filePath, p1: localMediaMarker(filePath, mimeType, temporary) }) }],
        details: { source: "local download", path: filePath, mimeType } };
    },
  }];
}
