import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { MessageAttachmentInfo, ModelConfigInfo } from "@qone/protocol";
import path from "node:path";
import { configuredCapabilities } from "./media-capabilities.js";
import { createAttachmentAudioTool, createAttachmentFrameTool, createVideoDownloadTool, createVideoFallbackTools } from "./media-tool.js";
import { createDouyinTools } from "./douyin-tools.js";
import { createAppMediaTools } from "./app-media-tools.js";
import { createActivityTitleTool } from "./activity-title-tool.js";
import { runtimeError } from "./runtime-localization.js";
import { downloadDouyinVideo } from "./video-download.js";
import type { DouyinBridge } from "./douyin-bridge.js";
import type { AppMediaService } from "./app-media-service.js";
import type { EmbeddedOpenCliRunner } from "./browser-sync.js";

/** Everything the media tools need from the session that owns the run. */
export interface MediaToolHost {
  activeRunId(): string | undefined;
  modelOf(): { provider: string; id: string; api: string } | undefined;
  configuredModelConfigs(): readonly ModelConfigInfo[];
  registerMedia(runId: string, mediaPath: string, mimeType: string, directory?: string): void;
  registerDirectory(runId: string, directory: string): void;
  attachment(runId: string, attachmentId: string): MessageAttachmentInfo | undefined;
  hasMedia(runId: string, mediaPath: string): boolean;
  isTemporary(runId: string, filePath: string): boolean;
  douyinBridge?: DouyinBridge;
  appMediaService?: AppMediaService;
  openCli?: EmbeddedOpenCliRunner;
}

/** Media download/attachment tools, gated on the run's model capabilities. */
export function createMediaTools(host: MediaToolHost, workspacePath: string, modelName: string | undefined): ToolDefinition[] {
  const options = {
    active: () => {
      const runId = host.activeRunId();
      const model = host.modelOf();
      return runId && model ? { runId, model } : undefined;
    },
    configs: () => host.configuredModelConfigs(),
    registerMedia: (runId: string, mediaPath: string, mimeType: string, directory?: string) => {
      if (directory) host.registerDirectory(runId, directory);
      host.registerMedia(runId, mediaPath, mimeType, directory);
    },
    registerDirectory: (runId: string, directory: string) => host.registerDirectory(runId, directory),
    attachment: (runId: string, attachmentId: string) => host.attachment(runId, attachmentId),
    hasMedia: (runId: string, mediaPath: string) => host.hasMedia(runId, mediaPath),
    isTemporary: (runId: string, filePath: string) => host.isTemporary(runId, filePath),
    douyinDownload: host.douyinBridge
      ? (url: string, signal?: AbortSignal) => downloadDouyinVideo(url, (target, requestSignal) => host.douyinBridge!.request(target, requestSignal), signal)
      : undefined,
    bilibiliDownload: host.appMediaService
      ? async (url: string, mode: "video" | "audio", signal?: AbortSignal) => {
        const result = await host.appMediaService!.download("bilibili", url, mode, undefined, signal);
        const file = result.files[0];
        if (!file) throw runtimeError("app-media.no_output", {});
        return file;
      }
      : undefined,
    openCli: host.openCli,
  };
  const caps = modelName ? configuredCapabilities(host.configuredModelConfigs(), modelName) : configuredCapabilities([], "");
  return [
    ...(caps.video.native || caps.video.frames || caps.audio.native ? [createVideoDownloadTool(options)] : []),
    ...(caps.audio.extract ? [createAttachmentAudioTool(options)] : []),
    ...(caps.video.frames ? [createAttachmentFrameTool(options)] : []),
    ...(caps.video.frames || caps.audio.extract ? createVideoFallbackTools(options) : []),
    ...(host.douyinBridge ? createDouyinTools(host.douyinBridge, workspacePath) : []),
    ...(host.appMediaService && host.openCli ? createAppMediaTools(host.appMediaService, workspacePath, host.openCli) : []),
  ] as ToolDefinition[];
}

/** Goal bookkeeping tools, only present for goal-driven runs. */
export interface GoalToolHost {
  get(sessionId: string, goalId: string, epoch: number, runId: string): unknown;
  complete(sessionId: string, goalId: string, epoch: number, runId: string, summary: string): unknown;
  blocked(sessionId: string, goalId: string, epoch: number, runId: string, reason: string, evidence: string): unknown;
  wait(sessionId: string, goalId: string, epoch: number, runId: string, reason: string, resumeAfterMs?: number): unknown;
}

function createGoalTools(host: GoalToolHost | undefined, eventSessionId: string, goalId: string | undefined, goalEpoch: number | undefined, goalRunId: string | undefined): ToolDefinition[] {
  if (!goalId || goalEpoch === undefined || !goalRunId || !host) return [];
  const bridge = host;
  return [{
    name: "get_goal", label: "Get goal", description: "Read the current goal and its execution state.",
    parameters: Type.Object({}),
    execute: async () => ({ content: [{ type: "text", text: JSON.stringify(bridge.get(eventSessionId, goalId, goalEpoch, goalRunId)) }], details: {} }),
  }, {
    name: "goal_complete", label: "Complete goal", description: "Mark the current goal complete only after the requested work and verification are finished.",
    parameters: Type.Object({ summary: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => ({ content: [{ type: "text", text: JSON.stringify(bridge.complete(eventSessionId, goalId, goalEpoch, goalRunId, (params as { summary: string }).summary)) }], details: {} }),
  }, {
    name: "goal_blocked", label: "Block goal", description: "Report a real external or technical blocker with evidence.",
    parameters: Type.Object({ reason: Type.String({ minLength: 1 }), evidence: Type.String({ minLength: 1 }) }),
    execute: async (_toolCallId, params) => { const input = params as { reason: string; evidence: string }; return { content: [{ type: "text", text: JSON.stringify(bridge.blocked(eventSessionId, goalId, goalEpoch, goalRunId, input.reason, input.evidence)) }], details: {} }; },
  }, {
    name: "goal_wait", label: "Wait for goal event", description: "Wait for an external event before continuing the goal.",
    parameters: Type.Object({ reason: Type.String({ minLength: 1 }), resume_after_ms: Type.Optional(Type.Number({ minimum: 1 })) }),
    execute: async (_toolCallId, params) => { const input = params as { reason: string; resume_after_ms?: number }; return { content: [{ type: "text", text: JSON.stringify(bridge.wait(eventSessionId, goalId, goalEpoch, goalRunId, input.reason, input.resume_after_ms)) }], details: {} }; },
  }] as ToolDefinition[];
}

/** Product-internal tools that never need a permission prompt. */
export function createInternalTools(goalHost: GoalToolHost | undefined, eventSessionId: string, goalId: string | undefined, goalEpoch: number | undefined, goalRunId: string | undefined): ToolDefinition[] {
  return [createActivityTitleTool(), ...createGoalTools(goalHost, eventSessionId, goalId, goalEpoch, goalRunId)];
}
/** Builds the media host from an adapter's per-session maps. */
export function mediaToolHostFor(adapter: {
  activeRunIds: Map<string, string>;
  sessions: Map<string, { agent: { state: { model?: { provider: string; id: string; api: string } } } }>;
  configuredModelConfigs: readonly ModelConfigInfo[];
  downloadedVideoPaths: Map<string, Map<string, string>>;
  mediaAttachmentRefs: Map<string, Map<string, MessageAttachmentInfo>>;
  videoTempDirs: Map<string, Set<string>>;
  douyinBridge?: DouyinBridge;
  appMediaService?: AppMediaService;
  openCli?: EmbeddedOpenCliRunner;
  registerMediaDirectory(runId: string, directory: string): void;
}, sessionId: string): MediaToolHost {
  return {
    activeRunId: () => adapter.activeRunIds.get(sessionId),
    modelOf: () => adapter.sessions.get(sessionId)?.agent.state.model ?? undefined,
    configuredModelConfigs: () => adapter.configuredModelConfigs,
    registerMedia: (runId, mediaPath, mimeType, directory) => {
      if (directory) adapter.registerMediaDirectory(runId, directory);
      const paths = adapter.downloadedVideoPaths.get(runId) ?? new Map<string, string>();
      paths.set(mediaPath, mimeType);
      adapter.downloadedVideoPaths.set(runId, paths);
    },
    registerDirectory: (runId, directory) => adapter.registerMediaDirectory(runId, directory),
    attachment: (runId, attachmentId) => adapter.mediaAttachmentRefs.get(runId)?.get(attachmentId),
    hasMedia: (runId, mediaPath) => adapter.downloadedVideoPaths.get(runId)?.has(mediaPath) ?? false,
    isTemporary: (runId, filePath) => [...adapter.videoTempDirs.get(runId) ?? []].some((directory) => {
      const relative = path.relative(directory, filePath);
      return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
    }),
    douyinBridge: adapter.douyinBridge,
    appMediaService: adapter.appMediaService,
    openCli: adapter.openCli,
  };
}
