import { runtimeText, runtimeError } from "./runtime-localization";
import {
  createAgentSession,
  createReadTool,
  createPowerShellTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ToolDefinition,
  type ResourceLoader,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import { Type } from "typebox";
import { rm } from "node:fs/promises";
import path from "node:path";
import { detectImageModel, modelListUrl, normalizeThinkingLevelForApi, type AgentEvent, type ImageApiFormat, type MessageAttachmentInfo, type ModelConfigInfo, type ModelMetadata, type ProviderApiType, type RunPermissionMode, type RunThinkingLevel } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { ModelResponseTiming } from "./model-response-timing.js";
import { contextTokens, subscribeContextUsage } from "./context-usage.js";
import { SessionInputQueue } from "./session-input-queue.js";
import { SIDE_CHAT_INSTRUCTIONS } from "./side-conversation.js";
import { createFileChangeTools } from "./file-change-tools.js";
import { createActivityTitleTool } from "./activity-title-tool.js";
import { ApprovalQueue, withPermission, type PermissionRuleStore } from "./permissions.js";
import { createResourceLoader } from "./skills.js";
import { generateImage } from "./image-generation.js";
import { generateSpeech } from "./speech-generation.js";
import { generateVideo } from "./video-generation.js";
import { createSubagentTools } from "./subagent-tools.js";
import type { SubagentSelection } from "./subagent-selection.js";
import { googleMediaContent, googleStreamSimple } from "./google-media.js";
import { openAICompletionsStreamSimple } from "./openai-audio.js";
import { codexResponsesMediaStreamSimple, openAIResponsesMediaStreamSimple } from "./openai-responses-media.js";
import { anthropicMediaStreamSimple } from "./anthropic-media.js";
import { ModelMetadataResolver, providerBaseUrl } from "./model-resolver.js";
import { canProcessMediaAttachment, configuredCapabilities, mediaCapabilitiesContext } from "./media-capabilities.js";
import { createPiSessionEntries, imageContent, materializeModelInputs, promptWithAttachments, videoAttachmentNotice, type PersistedPiMessage } from "./pi-attachments.js";
import { createAttachmentAudioTool, createAttachmentFrameTool, createVideoDownloadTool, createVideoFallbackTools } from "./media-tool.js";
import { downloadDouyinVideo } from "./video-download.js";
import type { DouyinBridge } from "./douyin-bridge.js";
import { createDouyinTools } from "./douyin-tools.js";
import { extractTextContent, splitModelName } from "./pi-message-utils.js";
import { compactionReserveTokens, DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences, type PiCompactionPreferences } from "./pi-compaction.js";
import type { AppMediaService } from "./app-media-service.js";
import { createAppMediaTools } from "./app-media-tools.js";
import type { EmbeddedOpenCliRunner } from "./browser-sync.js";
import { withMediaPhaseReporter } from "./media-phase.js";

const log = createLogger("pi-adapter");
const MODEL_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
export const PI_REQUEST_OVERRIDES = { httpIdleTimeoutMs: 0 } as const;
export { compactionReserveTokens, DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences } from "./pi-compaction.js";
export type { PiCompactionPreferences } from "./pi-compaction.js";

function assertModelToolNames(names: Iterable<string>): void {
  const seen = new Set<string>();
  for (const name of names) {
    if (!MODEL_TOOL_NAME.test(name) || name.length > 64) throw new Error(`Invalid model tool name: ${name}`);
    if (seen.has(name)) throw new Error(`Duplicate model tool name: ${name}`);
    seen.add(name);
  }
}

type EmitFn = (event: AgentEvent) => void;
type RunEmitFn = (type: string, payload: unknown) => void;
type DelegateSubagent = (input: SubagentSelection & { parentSessionId: string; parentRunId: string; parentSubagentId?: string; depth?: number; toolCallId: string; task: string; title: string; reason: string; expectedResult: string; mediaAttachment?: MessageAttachmentInfo & { temporary?: boolean }; fallbackModel?: string; permissionMode: RunPermissionMode; background?: boolean; signal?: AbortSignal }) => Promise<string>;
type SubagentController = import("./subagent-runner.js").SubagentController;

type AutomaticMediaDelegation = {
  result: string;
  status: string;
};

function parseAutomaticMediaDelegation(value: string): AutomaticMediaDelegation | undefined {
  try {
    const parsed = JSON.parse(value) as { status?: unknown; result?: unknown; error?: unknown };
    if (typeof parsed !== "object" || parsed === null || typeof parsed.status !== "string") return undefined;
    const result = typeof parsed.result === "string" && parsed.result.trim()
      ? parsed.result.trim()
      : typeof parsed.error === "string" && parsed.error.trim() ? parsed.error.trim() : "";
    return result ? { result, status: parsed.status } : undefined;
  } catch {
    return undefined;
  }
}

export interface GoalRuntimeBridge {
  get(sessionId: string, goalId: string, epoch: number, runId: string): unknown;
  complete(sessionId: string, goalId: string, epoch: number, runId: string, summary: string): unknown;
  blocked(sessionId: string, goalId: string, epoch: number, runId: string, reason: string, evidence: string): unknown;
  wait(sessionId: string, goalId: string, epoch: number, runId: string, reason: string, resumeAfterMs?: number): unknown;
}

export { imageContent, promptWithAttachments, createPiSessionEntries } from "./pi-attachments.js";
export type { PersistedPiMessage } from "./pi-attachments.js";

interface PiAdapterHooks {
  onMessage?: (sessionId: string, runId: string, role: "assistant" | "tool", content: string) => void;
  onAssistantFinal?: (sessionId: string, runId: string, content: string) => void;
  onTool?: (sessionId: string, runId: string, phase: "start" | "end", name: string, args?: unknown, result?: unknown, toolCallId?: string, parentToolCallId?: string) => void;
  webAccessContext?: (sessionId: string, task?: string) => string;
  onCustomEntry?: (sessionId: string, entry: unknown) => void;
  onGeneratedMedia?: (sessionId: string, runId: string, data: Uint8Array | ReadableStream<Uint8Array>, mimeType: string, extension: string, signal: AbortSignal) => Promise<string>;
}

// Wraps pi-coding-agent sessions and re-emits their events as our
// internal AgentEvent protocol so the GUI never imports Pi types.
// Coding tools (read/grep/find/ls/edit/write/powershell) come built in
// via createAgentSession — no custom search service needed for V1.
// MCP tools are injected through customTools. Skills are loaded through Pi's
// ResourceLoader rather than exposed as model-callable tools.
export class PiAdapter {
  private isSideConversation: (sessionId: string) => boolean = () => false;
  setSideConversationResolver(resolve: (sessionId: string) => boolean) { this.isSideConversation = resolve; }
  private emit: EmitFn;
  private sessions = new Map<string, AgentSession>();
  private runs = new Map<string, AgentSession>();
  private activeRunIds = new Map<string, string>();
  private readonly sessionInputs = new SessionInputQueue();
  private runModes = new Map<string, RunPermissionMode>();
  private stoppedRuns = new Set<string>();
  private seq = 0;
  private customTools: ToolDefinition[] = [];
  private staleSessions = new Set<string>();
  private approvals = new ApprovalQueue();
  private pendingApprovalIds = new Map<string, Set<string>>();
  private hooks: PiAdapterHooks;
  private delegateSubagent?: DelegateSubagent;
  private subagentController?: SubagentController;
  private subagentPolicy?: () => { allowNested: boolean; maxDepth: number; maxConcurrent: number };
  private resourceLoaders = new Map<string, ResourceLoader>();
  private modelRuntime?: ModelRuntime;
  private thinkingLevels = new Map<string, ThinkingLevel>();
  private modelApiTypes = new Map<string, ProviderApiType>();
  private modelApiKeys = new Map<string, string>();
  private configuredModelConfigs: ModelConfigInfo[] = [];
  private configuredModelConfigFingerprint = "";
  private queuedModelConfigFingerprint?: string;
  private imageModelConfigs = new Map<string, ModelConfigInfo>();
  private speechModelConfigs = new Map<string, ModelConfigInfo>();
  private videoModelConfigs = new Map<string, ModelConfigInfo>();
  private generationRunControllers = new Map<string, AbortController>();
  private videoTempDirs = new Map<string, Set<string>>();
  private downloadedVideoPaths = new Map<string, Map<string, string>>();
  private mediaAttachmentRefs = new Map<string, Map<string, MessageAttachmentInfo>>();
  private mediaRunControllers = new Map<string, AbortController>();
  private registerMediaDirectory(runId: string, directory: string): void {
    const directories = this.videoTempDirs.get(runId) ?? new Set<string>();
    directories.add(directory);
    this.videoTempDirs.set(runId, directories);
  }
  private rememberVideoAttachments(runId: string, attachments: readonly MessageAttachmentInfo[] | undefined): string {
    const refs = this.mediaAttachmentRefs.get(runId) ?? new Map<string, MessageAttachmentInfo>();
    const notice = videoAttachmentNotice(attachments, refs);
    if (notice) this.mediaAttachmentRefs.set(runId, refs);
    return notice;
  }
  private goalBridge?: GoalRuntimeBridge;
  private modelConfigurationQueue: Promise<void> = Promise.resolve();
  private readonly sessionSettingsManagers = new Map<string, SettingsManager>();
  private readonly compactingSessions = new Set<string>();
  private compactionPreferences: PiCompactionPreferences;
  private modelMetadataResolver = new ModelMetadataResolver({
    providerModelsFetcher: async ({ provider, apiType, piApi, baseUrl, catalogBaseUrl, apiKey }) => {
      // Use the catalog URL for `/models`; the runtime URL is intentionally
      // query-free for the private Codex adapter.
      const endpointBase = catalogBaseUrl || providerBaseUrl(apiType, piApi, baseUrl);
      if (!endpointBase) return [];
      const headers: Record<string, string> = { Accept: "application/json" };
      if (apiType === "claude") {
        if (apiKey) headers["x-api-key"] = apiKey;
        headers["anthropic-version"] = "2023-06-01";
      } else if (apiType !== "google" && apiKey) {
        headers.Authorization = `Bearer ${apiKey}`;
      }
      const url = modelListUrl(apiType, endpointBase);
      if (!url) return [];
      const requestUrl = new URL(url);
      if (apiType === "google" && apiKey) requestUrl.searchParams.set("key", apiKey);
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 2_500);
      try {
        const response = await fetch(requestUrl, { headers, signal: controller.signal });
        if (!response.ok) throw new Error(`provider models HTTP ${response.status}`);
        return await response.json();
      } finally {
        clearTimeout(timer);
      }
    },
  });

  constructor(
    emit: EmitFn,
    hooks: PiAdapterHooks = {},
    private permissionRules?: PermissionRuleStore,
    private restoreMessages?: (sessionId: string, currentRunId?: string) => PersistedPiMessage[],
    compactionPreferences: PiCompactionPreferences = DEFAULT_PI_COMPACTION_PREFERENCES,
    private douyinBridge?: DouyinBridge,
    private appMediaService?: AppMediaService,
    private openCli?: EmbeddedOpenCliRunner,
  ) {
    this.emit = emit;
    this.hooks = hooks;
    this.compactionPreferences = normalizePiCompactionPreferences(compactionPreferences);
    this.applyCompactionSettings();
  }

  private compactionOverrides() {
    const modelOverrides = Object.fromEntries(
      (this.modelRuntime?.getModels() ?? [])
        .filter((model) => Number.isSafeInteger(model.contextWindow) && model.contextWindow > 0)
        .map((model) => [model.provider + "/" + model.id, {
          // Pi triggers when contextTokens > contextWindow - reserveTokens.
          // Mapping the user percentage here keeps the UI independent of the
          // model's actual context window while retaining Pi's own compaction.
          reserveTokens: compactionReserveTokens(model.contextWindow, this.compactionPreferences.compactionThreshold),
        }]),
    );
    return {
      compaction: {
        enabled: this.compactionPreferences.autoCompactionEnabled,
        modelOverrides,
      },
    };
  }

  private applyCompactionSettings(): void {
    const overrides = this.compactionOverrides();
    for (const manager of this.sessionSettingsManagers.values()) manager.applyOverrides(overrides);
  }

  setCompactionPreferences(value: PiCompactionPreferences): PiCompactionPreferences {
    this.compactionPreferences = normalizePiCompactionPreferences(value);
    this.applyCompactionSettings();
    for (const session of this.sessions.values()) session.setAutoCompactionEnabled(this.compactionPreferences.autoCompactionEnabled);
    return this.compactionPreferences;
  }

  getCompactionPreferences(): PiCompactionPreferences {
    return { ...this.compactionPreferences };
  }

  // Called once at boot after MCP manager finishes loading.
  async setCustomTools(tools: ToolDefinition[]) {
    this.customTools = tools;
    for (const [sessionId, session] of this.sessions) {
      if (session.isIdle) {
        await session.dispose();
        this.sessions.delete(sessionId);
        this.sessionSettingsManagers.delete(sessionId);
      } else {
        // Do not interrupt an active run. It will be recreated after settling.
        this.staleSessions.add(sessionId);
      }
    }
  }

  async configureModels(configs: ModelConfigInfo[], force = false): Promise<void> {
    // Commands and credential restoration arrive concurrently over NDJSON.
    // Serialize registry replacement so an older, slower /models request
    // cannot overwrite a newer model configuration.
    const snapshot = configs.map((item) => ({ ...item, config: { ...item.config } }));
    const fingerprint = JSON.stringify(snapshot);
    if (!force && (fingerprint === this.configuredModelConfigFingerprint || fingerprint === this.queuedModelConfigFingerprint)) {
      return this.modelConfigurationQueue;
    }
    const operation = this.modelConfigurationQueue.then(() => this.applyModelConfiguration(snapshot));
    this.modelConfigurationQueue = operation.catch(() => undefined);
    this.queuedModelConfigFingerprint = fingerprint;
    return operation.then(() => {
      this.configuredModelConfigFingerprint = fingerprint;
      if (this.queuedModelConfigFingerprint === fingerprint) this.queuedModelConfigFingerprint = undefined;
    }, (error) => {
      if (this.queuedModelConfigFingerprint === fingerprint) this.queuedModelConfigFingerprint = undefined;
      throw error;
    });
  }

  setSubagentDispatcher(dispatcher: DelegateSubagent) {
    this.delegateSubagent = dispatcher;
  }

  setSubagentController(controller: SubagentController) {
    this.subagentController = controller;
  }

  setSubagentPolicy(policy: () => { allowNested: boolean; maxDepth: number; maxConcurrent: number }) {
    this.subagentPolicy = policy;
  }

  setGoalBridge(bridge: GoalRuntimeBridge) {
    this.goalBridge = bridge;
  }

  async refreshSkills(): Promise<void> {
    this.resourceLoaders.clear();
    for (const [sessionId, session] of this.sessions) {
      if (session.isIdle) {
        await session.dispose();
        this.sessions.delete(sessionId);
        this.sessionSettingsManagers.delete(sessionId);
      } else {
        this.staleSessions.add(sessionId);
      }
    }
  }

  private async applyModelConfiguration(configs: ModelConfigInfo[]): Promise<void> {
    this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
    this.configuredModelConfigs = configs;
    this.imageModelConfigs = new Map();
    this.speechModelConfigs = new Map();
    this.videoModelConfigs = new Map();
    const grouped = new Map<string, ModelConfigInfo[]>();
    this.modelApiTypes = new Map(configs.filter((item) => item.enabled).map((item) => [`${item.provider}/${item.model}`, item.config.apiType as ProviderApiType]));
    this.thinkingLevels = new Map(configs.filter((item) => item.enabled).map((item) => {
      const configured = normalizeThinkingLevelForApi(item.config.thinking, item.config.apiType as ProviderApiType);
      const level = configured === "none" ? "off" : configured;
      return [`${item.provider}/${item.model}`, level as ThinkingLevel];
    }));
    for (const config of configs.filter((item) => item.enabled)) grouped.set(config.provider, [...(grouped.get(config.provider) ?? []), config]);
    for (const provider of this.modelRuntime.getRegisteredProviderIds()) if (!grouped.has(provider)) this.modelRuntime.unregisterProvider(provider);
    for (const [provider, models] of grouped) {
      const resolved = await Promise.all(models.map((item) => this.modelMetadataResolver.resolve({
        provider,
        model: item.model,
        config: { ...item.config, apiType: String(item.config.apiType ?? "openai-compatible") },
        apiKey: this.modelApiKeys.get(provider),
      })));
      for (const [index, item] of models.entries()) {
        const raw = item.config;
        const metadata = resolved[index]!.metadata;
        const detected = detectImageModel({
          model: item.model,
          provider: item.provider,
          apiType: typeof raw.apiType === "string" ? raw.apiType : undefined,
          imageApiFormat: typeof raw.imageApiFormat === "string" ? raw.imageApiFormat as ImageApiFormat : undefined,
          input: Array.isArray(raw.input) ? raw.input as string[] : undefined,
          output: Array.isArray(raw.output) ? raw.output as string[] : undefined,
          manualInput: Boolean(raw.metadataOverrides && typeof raw.metadataOverrides === "object" && (raw.metadataOverrides as Record<string, unknown>).input === true),
          manualOutput: Boolean(raw.metadataOverrides && typeof raw.metadataOverrides === "object" && (raw.metadataOverrides as Record<string, unknown>).output === true),
          metadata,
        });
        if (detected.isImageModel) {
          // Keep the resolved provider capability in the transient config so
          // the run path uses the same detection result before the UI saves it.
          this.imageModelConfigs.set(item.id, { ...item, config: { ...raw, modelMetadata: metadata } });
        } else if (configuredCapabilities(configs, `${item.provider}/${item.model}`).output.includes("video")) {
          this.videoModelConfigs.set(item.id, { ...item, config: { ...raw, modelMetadata: metadata } });
        } else if (configuredCapabilities(configs, `${item.provider}/${item.model}`).output.includes("audio")) {
          this.speechModelConfigs.set(item.id, { ...item, config: { ...raw, modelMetadata: metadata } });
        }
      }
      const firstResolved = resolved[0];
      this.modelRuntime.registerProvider(provider, {
        name: provider,
        baseUrl: firstResolved.baseUrl,
        api: firstResolved.api as never,
        streamSimple: ((model: Parameters<typeof googleStreamSimple>[0], context: Parameters<typeof googleStreamSimple>[1], options: Parameters<typeof googleStreamSimple>[2]) => {
          const input = configuredCapabilities(this.configuredModelConfigs, `${model.provider}/${model.id}`).input;
          if (model.api === "google-generative-ai") return googleStreamSimple(model, context, options, input.includes("video"), input);
          if (model.api === "openai-completions") return openAICompletionsStreamSimple(model, context, options, input);
          if (model.api === "anthropic-messages") return anthropicMediaStreamSimple(model, context, options, input);
          if (model.api === "openai-responses") return openAIResponsesMediaStreamSimple(model, context, options, input);
          if (model.api === "openai-codex-responses") return codexResponsesMediaStreamSimple(model, context, options, input);
          throw new Error(`Unsupported model API: ${model.api}`);
        }) as never,
        models: models.map((item, index) => {
          const model = resolved[index];
          const configuredInput = configuredCapabilities(this.configuredModelConfigs, `${item.provider}/${item.model}`).input;
          return {
            id: item.model,
            name: model.name,
            api: model.api as never,
            baseUrl: model.baseUrl,
            reasoning: model.reasoning,
            input: configuredInput.includes("image") ? ["text", "image"] as ("text" | "image")[] : ["text"] as ("text" | "image")[],
            cost: model.cost,
            contextWindow: model.contextWindow,
            maxTokens: model.maxTokens,
            ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
            ...(model.compat ? { compat: model.compat } : {}),
            ...(model.samplingParams ? { samplingParams: model.samplingParams } : {}),
          };
        }),
      });
    }
    this.applyCompactionSettings();
    for (const sessionId of this.sessions.keys()) this.staleSessions.add(sessionId);
  }

  private thinkingLevelForModel(modelName: string): ThinkingLevel | undefined {
    const direct = this.thinkingLevels.get(modelName);
    if (direct) return direct;
    const [provider, model] = splitModelName(modelName);
    return this.thinkingLevels.get(`${provider}/${model}`) ?? this.thinkingLevels.get(`${provider}:${model}`);
  }

  async disposeSession(sessionId: string): Promise<void> {
    this.resourceLoaders.delete(`side-chat:${sessionId}`);
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.dispose();
      this.sessions.delete(sessionId);
    }
    this.sessionSettingsManagers.delete(sessionId);
    this.staleSessions.delete(sessionId);
  }

  getSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** Store credentials only in the live process and hand them to Pi's
   * provider runtime. The desktop persists the same value in Credential
   * Manager; it is never written to SQLite. */
  async setSecret(key: string, value: string): Promise<void> {
    const provider = key.startsWith("model.apiKey:") ? key.slice("model.apiKey:".length) : key;
    if (key.startsWith("model.apiKey:")) this.modelApiKeys.set(provider, value);
    this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
    await this.modelRuntime.setRuntimeApiKey(provider, value);
    if (key.startsWith("model.apiKey:") && this.configuredModelConfigs.length > 0) {
      this.modelMetadataResolver.invalidateProviderCatalog(provider);
      await this.configureModels(this.configuredModelConfigs, true).catch((error) => {
        log.warn("model metadata refresh failed", { provider, err: String(error) });
      });
    }
  }

  isRunning(sessionId: string): boolean {
    return this.compactingSessions.has(sessionId) || this.activeRunIds.has(sessionId);
  }

  activeRunId(sessionId: string): string | undefined {
    return this.activeRunIds.get(sessionId);
  }

  isDirectGenerationModel(modelName: string): boolean {
    return this.imageModelConfigs.has(modelName) || this.videoModelConfigs.has(modelName) || this.speechModelConfigs.has(modelName);
  }

  async compactSession(sessionId: string, cwd: string, modelName: string): Promise<unknown[]> {
    if (this.isRunning(sessionId)) throw new Error("session already has an active run or compaction");
    this.compactingSessions.add(sessionId);
    try {
      const session = await this.getSession(sessionId, cwd, modelName);
      if (!session.isIdle) throw new Error("session is busy");
      const settings = this.sessionSettingsManagers.get(sessionId)!;
      const keepRecentTokens = settings.getCompactionKeepRecentTokens(session.model);
      // Pi's manual entry point still uses keepRecentTokens. Zero makes the
      // action independent of the automatic threshold and short-chat budget.
      settings.applyOverrides({ compaction: { keepRecentTokens: 0 } });
      try {
        await session.compact();
        return [...session.agent.state.messages];
      } finally {
        settings.applyOverrides({ compaction: { keepRecentTokens } });
      }
    } finally {
      this.compactingSessions.delete(sessionId);
    }
  }

  async getContextUsage(sessionId: string, cwd: string, modelName: string): Promise<{ tokens: number; contextWindow: number }> {
    const [provider, modelId] = splitModelName(modelName);
    this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
    const model = this.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`configured model not found: ${modelName}`);
    const existing = this.sessions.get(sessionId);
    if (!existing && this.isRunning(sessionId)) throw new Error("session context is not ready yet");
    const session = existing && !(this.staleSessions.has(sessionId) && existing.isIdle)
      ? existing
      : await this.getSession(sessionId, cwd, modelName);
    return {
      tokens: contextTokens(session),
      contextWindow: model.contextWindow,
    };
  }

  async deleteSecret(key: string): Promise<void> {
    const provider = key.startsWith("model.apiKey:") ? key.slice("model.apiKey:".length) : key;
    if (key.startsWith("model.apiKey:")) this.modelApiKeys.delete(provider);
    this.modelMetadataResolver.invalidateProviderCatalog(provider);
    if (this.modelRuntime) await this.modelRuntime.removeRuntimeApiKey(provider);
    if (key.startsWith("model.apiKey:") && this.configuredModelConfigs.length > 0) {
      await this.configureModels(this.configuredModelConfigs, true).catch((error) => {
        log.warn("model metadata refresh after credential removal failed", { provider, err: String(error) });
      });
    }
  }

  async generateTitle(prompt: string, modelName?: string, signal?: AbortSignal): Promise<string> {
    this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
    const model = modelName
      ? this.modelRuntime.getModel(...splitModelName(modelName))
      : this.modelRuntime.getModels()[0];
    if (!model) throw new Error("no configured model available for title generation");
    const response = await this.modelRuntime.completeSimple(model, {
      systemPrompt: "Generate a concise conversation title from the user's first message. Return only valid JSON with one string field named title. The title must be a short topic, never an answer to the user. Keep it under 8 words in English or 20 Chinese characters.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, { maxTokens: 32, temperature: 0.2, signal });
    const title = extractTextContent(response)
      .replace(/[\r\n]+/g, " ")
      .replace(/^['"“”‘’`]+|['"“”‘’`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) throw new Error("model returned an empty title");
    return title.slice(0, 80);
  }

  private push(type: string, payload: unknown, sessionId: string, runId?: string) {
    this.emit({
      eventId: crypto.randomUUID(),
      sequence: this.seq++,
      type,
      sessionId,
      runId,
      timestamp: Date.now(),
      payload,
    });
  }

  private async getSession(sessionId: string, cwd?: string, modelName?: string, thinkingOverride?: RunThinkingLevel, eventSessionId = sessionId, mcpServerId?: string, subagentDepth = 0, subagentRunId?: string, goalId?: string, goalEpoch?: number, goalRunId?: string): Promise<AgentSession> {
    const modelKey = modelName ? splitModelName(modelName).join("/") : undefined;
    const apiType = modelKey ? this.modelApiTypes.get(modelKey) : undefined;
    const override = thinkingOverride ? normalizeThinkingLevelForApi(thinkingOverride, apiType) : undefined;
    const thinking = override ? (override === "none" ? "off" : override) : modelName ? this.thinkingLevelForModel(modelName) : undefined;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (mcpServerId && !existing.isIdle) throw new Error("session is busy");
      if ((mcpServerId || this.staleSessions.has(sessionId)) && existing.isIdle) {
        await existing.dispose();
        this.sessions.delete(sessionId);
        this.sessionSettingsManagers.delete(sessionId);
        this.staleSessions.delete(sessionId);
      } else {
      if (modelName) {
        this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
        const [provider, modelId] = splitModelName(modelName);
        const nextModel = this.modelRuntime.getModel(provider, modelId);
        if (!nextModel) throw new Error(`configured model not found: ${modelName}`);
        const currentModel = existing.agent.state.model;
        if (currentModel && `${currentModel.provider}/${currentModel.id}` !== modelName && existing.isIdle) {
          await existing.dispose();
          this.sessions.delete(sessionId);
          this.sessionSettingsManagers.delete(sessionId);
          return this.getSession(sessionId, cwd, modelName, thinkingOverride, eventSessionId, mcpServerId, subagentDepth, subagentRunId, goalId, goalEpoch, goalRunId);
        }
        await existing.setModel(nextModel);
         if (thinking) existing.setThinkingLevel(thinking);
      }
      return existing;
      }
    }

    const workspacePath = cwd ?? process.cwd();
    const sideConversation = this.isSideConversation(sessionId);
    const resourceKey = sideConversation
      ? `${subagentDepth > 0 ? "subagent-side-chat" : "side-chat"}:${sessionId}`
      : subagentDepth > 0 ? `subagent:${workspacePath}` : workspacePath;
    if (!this.resourceLoaders.has(resourceKey)) {
      const { loader } = await createResourceLoader(workspacePath, sideConversation ? SIDE_CHAT_INSTRUCTIONS : undefined, true, subagentDepth > 0);
      this.resourceLoaders.set(resourceKey, loader);
    }
    const builtinTools = [
      createReadTool(workspacePath),
      createPowerShellTool(workspacePath, {
        // PowerShell 7 can emit ANSI color codes for formatted objects. The
        // tool output is sent to the chat as plain text, so those codes would
        // become visible as garbled characters instead of colors.
        spawnHook: ({ command, ...context }) => ({
          ...context,
          command: "try { $PSStyle.OutputRendering = 'PlainText' } catch {}\n" + command,
        }),
      }),
      ...createFileChangeTools(workspacePath),
      createGrepTool(workspacePath),
      createFindTool(workspacePath),
      createLsTool(workspacePath),
    ];
    const customTools = mcpServerId
      ? this.customTools.filter((tool) => (tool as ToolDefinition & { qoneToolName?: string }).qoneToolName?.startsWith(`mcp:${mcpServerId}:`))
      : this.customTools;
    const policy = this.subagentPolicy?.();
    const canDelegate = this.delegateSubagent && (!subagentRunId || (policy?.allowNested ?? true)) && subagentDepth < (policy?.maxDepth ?? 3);
    const subagentTools = sideConversation ? [] : createSubagentTools({
      controller: this.subagentController, delegate: this.delegateSubagent, canDelegate: Boolean(canDelegate),
      eventSessionId, subagentRunId, subagentDepth, modelName, maxConcurrent: policy?.maxConcurrent,
      parentRunId: () => this.activeRunIds.get(sessionId),
      permissionMode: () => this.runModes.get(sessionId) ?? "ask",
      mediaMimeType: (runId, mediaPath) => this.downloadedVideoPaths.get(runId)?.get(mediaPath),
    });
    const mediaToolOptions = {
      active: () => {
        const runId = this.activeRunIds.get(sessionId);
        const model = this.sessions.get(sessionId)?.agent.state.model;
        return runId && model ? { runId, model } : undefined;
      },
      configs: () => this.configuredModelConfigs,
      registerMedia: (runId: string, mediaPath: string, mimeType: string, directory?: string) => {
        if (directory) this.registerMediaDirectory(runId, directory);
        const paths = this.downloadedVideoPaths.get(runId) ?? new Map<string, string>();
        paths.set(mediaPath, mimeType);
        this.downloadedVideoPaths.set(runId, paths);
      },
      registerDirectory: (runId: string, directory: string) => this.registerMediaDirectory(runId, directory),
      attachment: (runId: string, attachmentId: string) => this.mediaAttachmentRefs.get(runId)?.get(attachmentId),
      hasMedia: (runId: string, mediaPath: string) => this.downloadedVideoPaths.get(runId)?.has(mediaPath) ?? false,
      isTemporary: (runId: string, filePath: string) => [...this.videoTempDirs.get(runId) ?? []].some((directory) => {
        const relative = path.relative(directory, filePath);
        return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
      }),
      douyinDownload: this.douyinBridge
        ? (url: string, signal?: AbortSignal) => downloadDouyinVideo(url, (target, requestSignal) => this.douyinBridge!.request(target, requestSignal), signal)
        : undefined,
      bilibiliDownload: this.appMediaService
        ? async (url: string, mode: "video" | "audio", signal?: AbortSignal) => {
          const result = await this.appMediaService!.download("bilibili", url, mode, undefined, signal);
          const file = result.files[0];
          if (!file) throw runtimeError("app-media.no_output", {});
          return file;
        }
        : undefined,
      openCli: this.openCli,
    };
    const modelCapabilities = modelName
      ? configuredCapabilities(this.configuredModelConfigs, modelName)
      : configuredCapabilities([], "");
    const mediaTools = [
      ...(modelCapabilities.video.native || modelCapabilities.video.frames || modelCapabilities.audio.native ? [createVideoDownloadTool(mediaToolOptions)] : []),
      ...(modelCapabilities.audio.extract ? [createAttachmentAudioTool(mediaToolOptions)] : []),
      ...(modelCapabilities.video.frames ? [createAttachmentFrameTool(mediaToolOptions)] : []),
      ...(modelCapabilities.video.frames || modelCapabilities.audio.extract ? createVideoFallbackTools(mediaToolOptions) : []),
      ...(this.douyinBridge ? createDouyinTools(this.douyinBridge, workspacePath) : []),
      ...(this.appMediaService && this.openCli ? createAppMediaTools(this.appMediaService, workspacePath, this.openCli) : []),
    ];
    const goalTools: ToolDefinition[] = goalId && goalEpoch !== undefined && goalRunId && this.goalBridge ? [{
      name: "get_goal", label: "Get goal", description: "Read the current goal and its execution state.",
      parameters: Type.Object({}),
      execute: async () => ({ content: [{ type: "text", text: JSON.stringify(this.goalBridge!.get(eventSessionId, goalId, goalEpoch, goalRunId)) }], details: {} }),
    }, {
      name: "goal_complete", label: "Complete goal", description: "Mark the current goal complete only after the requested work and verification are finished.",
      parameters: Type.Object({ summary: Type.String({ minLength: 1 }) }),
      execute: async (_toolCallId, params) => ({ content: [{ type: "text", text: JSON.stringify(this.goalBridge!.complete(eventSessionId, goalId, goalEpoch, goalRunId, (params as { summary: string }).summary)) }], details: {} }),
    }, {
      name: "goal_blocked", label: "Block goal", description: "Report a real external or technical blocker with evidence.",
      parameters: Type.Object({ reason: Type.String({ minLength: 1 }), evidence: Type.String({ minLength: 1 }) }),
      execute: async (_toolCallId, params) => { const input = params as { reason: string; evidence: string }; return { content: [{ type: "text", text: JSON.stringify(this.goalBridge!.blocked(eventSessionId, goalId, goalEpoch, goalRunId, input.reason, input.evidence)) }], details: {} }; },
    }, {
      name: "goal_wait", label: "Wait for goal event", description: "Wait for an external event before continuing the goal.",
      parameters: Type.Object({ reason: Type.String({ minLength: 1 }), resume_after_ms: Type.Optional(Type.Number({ minimum: 1 })) }),
      execute: async (_toolCallId, params) => { const input = params as { reason: string; resume_after_ms?: number }; return { content: [{ type: "text", text: JSON.stringify(this.goalBridge!.wait(eventSessionId, goalId, goalEpoch, goalRunId, input.reason, input.resume_after_ms)) }], details: {} }; },
    }] : [];
    const internalTools = [createActivityTitleTool(), ...goalTools];
    const internalToolNames = new Set(internalTools.map((tool) => tool.name));
    internalToolNames.add("finalize_response");
    const wrapped = [...builtinTools, ...customTools, ...subagentTools, ...mediaTools, ...internalTools].map((t) =>
      withPermission(t, {
        queue: this.approvals,
        workspacePath,
        rules: this.permissionRules,
        mode: () => this.runModes.get(sessionId) ?? "ask",
        internal: internalToolNames.has(t.name),
        emitApproval: (approvalId, toolName, args, toolCallId) => {
          const pending = this.pendingApprovalIds.get(sessionId) ?? new Set<string>();
          pending.add(approvalId);
          this.pendingApprovalIds.set(sessionId, pending);
          this.push("approval.requested", { approvalId, toolName, args, toolCallId }, eventSessionId, this.activeRunIds.get(sessionId));
        },
        emitResolved: (approvalId, toolCallId, approved) => {
          this.removePendingApproval(approvalId);
          this.push("approval.resolved", { approvalId, toolCallId, approved }, eventSessionId, this.activeRunIds.get(sessionId));
        },
      })
    );
    assertModelToolNames(wrapped.map((tool) => tool.name));

    const toolNameByModelName = new Map(wrapped.map((tool) => [
      tool.name,
      (tool as ToolDefinition & { qoneToolName?: string }).qoneToolName ?? tool.name,
    ]));

    const resourceLoader = this.resourceLoaders.get(resourceKey);
    let modelRuntime: ModelRuntime | undefined;
    let model: ReturnType<ModelRuntime["getModel"]> | undefined;
    if (modelName) {
      this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
      modelRuntime = this.modelRuntime;
      const [provider, modelId] = splitModelName(modelName);
      model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`configured model not found: ${modelName}`);
    }
    const restoredMessages = this.restoreMessages?.(sessionId, this.activeRunIds.get(sessionId)) ?? [];
    const preparedMessages = await Promise.all(restoredMessages.map(async (message) => ({
      ...message,
      attachments: message.role === "user"
        ? await materializeModelInputs(message.attachments, model?.api === "google-generative-ai", model ? configuredCapabilities(this.configuredModelConfigs, `${model.provider}/${model.id}`).input : undefined, true)
        : message.attachments,
    })));
    const sessionManager = SessionManager.inMemory(
      workspacePath,
      undefined,
      createPiSessionEntries(workspacePath, preparedMessages, model,
        model ? configuredCapabilities(this.configuredModelConfigs, `${model.provider}/${model.id}`).input : undefined),
    );
    const sessionSettings = SettingsManager.inMemory();
    sessionSettings.applyOverrides(this.compactionOverrides());
    sessionSettings.applyOverrides({ defaultTools: ["+codemode"] });
    // Let the provider and SDK decide when a request has failed. A value of 0
    // disables pi-coding-agent's HTTP idle timeout; local tool timeouts stay
    // independent of model request lifetime.
    sessionSettings.applyOverrides(PI_REQUEST_OVERRIDES);
    const { session } = await createAgentSession({
      cwd: workspacePath,
      sessionManager,
      // Built-ins are supplied as wrapped definitions so every tool goes through
      // the same permission boundary. Bash is intentionally omitted on Windows.
      tools: [...wrapped.map((tool) => tool.name), "codemode"],
      customTools: wrapped,
      resourceLoader,
      modelRuntime,
      settingsManager: sessionSettings,
      model,
      thinkingLevel: thinking,
    });
    await session.bindExtensions({});
    const previousFinishTurn = session.agent.finishTurn;
    session.agent.finishTurn = (async (turn, signal) => {
      const previous = await previousFinishTurn?.(turn, signal);
      const runId = this.activeRunIds.get(sessionId);
      if (!runId || !this.subagentController || turn.message.stopReason === "error" || turn.message.stopReason === "aborted") return previous;
      let dependencies = this.subagentController.dependencyStatus?.(runId);
      if (!dependencies || (!dependencies.blocking.length && !dependencies.unacknowledged.length && dependencies.authorized !== false)) return previous;
      const active = () => dependencies!.blocking.filter((child) => ["created", "running", "waiting_approval", "paused"].includes(child.status));
      if (active().length) {
        this.push("agent.waiting_subagents", { subagents: active().map((child) => ({ runId: child.id, title: child.title })) }, eventSessionId, runId);
        await this.subagentController.waitForDependencyChange(runId, signal);
        dependencies = this.subagentController.dependencyStatus(runId);
      }
      const ids = dependencies.blocking.map((child) => child.id);
      const instruction = ids.length
        ? `Required subagent results remain unresolved: ${ids.join(", ")}. Confirm the actual state, inspect each compact result, continue retryable failures with the same runId using follow_up, then call finalize_response before the final answer.`
        : "All required subagent results have been processed, but finalization has not been authorized. Call finalize_response with the handled run IDs before the final answer.";
      if (!session.agent.hasQueuedMessages()) {
        session.agent.steer({ role: "user", content: [{ type: "text", text: `[QONE_SUBAGENT_LEDGER]\n${instruction}` }], timestamp: Date.now() });
      }
      return { action: "continue" };
    }) as NonNullable<typeof session.agent.finishTurn>;
    try {
      assertModelToolNames(session.getActiveToolNames());
    } catch (error) {
      await session.dispose();
      throw error;
    }

    let lastToolDeltaAt = 0;
    const responseTiming = new ModelResponseTiming();
    if (eventSessionId === sessionId) subscribeContextUsage(session, (usage) => {
      const activeModel = session.model;
      const model = this.configuredModelConfigs.find((config) => config.provider === activeModel?.provider && config.model === activeModel?.id)?.id;
      if (model) this.push("context.usage", { model, ...usage }, sessionId, this.activeRunIds.get(sessionId));
    });
    session.subscribe((e) => {
      const candidateRunId = this.activeRunIds.get(sessionId);
      const runId = candidateRunId && this.runs.get(candidateRunId) === session ? candidateRunId : undefined;
      const raw = e as unknown as Record<string, unknown>;
      const messageEvent = raw.assistantMessageEvent as { type?: string; delta?: string; contentIndex?: number; toolCall?: unknown } | undefined;
      const normalized = messageEvent?.delta
        ? { ...raw, delta: messageEvent.delta }
        : raw;
      let protocolType: string = e.type;
      let protocolPayload = normalized;
      if (e.type === "message_start") {
        lastToolDeltaAt = 0;
        protocolType = "message.started";
      }
      else if (e.type === "message_update") {
        const content = (raw.message as { content?: unknown } | undefined)?.content;
        const block = Array.isArray(content) && typeof messageEvent?.contentIndex === "number"
          ? content[messageEvent.contentIndex] as { id?: string; name?: string; arguments?: unknown } | undefined
          : undefined;
        if (messageEvent?.type === "thinking_delta") {
          protocolType = "message.reasoning.delta";
          protocolPayload = { delta: messageEvent.delta ?? "", contentIndex: messageEvent.contentIndex };
        } else if (messageEvent?.type === "text_delta") {
          protocolType = "message.delta";
          protocolPayload = { delta: messageEvent.delta ?? "", contentIndex: messageEvent.contentIndex };
        } else if (messageEvent?.type === "thinking_start" || messageEvent?.type === "text_start" || messageEvent?.type === "toolcall_start") {
          protocolType = "message.block.started";
          protocolPayload = messageEvent.type !== "toolcall_start"
            ? { blockType: messageEvent.type === "thinking_start" ? "reasoning" : "text", contentIndex: messageEvent.contentIndex }
            : {
                blockType: "tool-call", contentIndex: messageEvent.contentIndex,
                toolCallId: block?.id,
                toolName: toolNameByModelName.get(String(block?.name ?? "")) ?? block?.name,
                args: block?.arguments,
              };
        } else if (messageEvent?.type === "toolcall_delta") {
          // Pi has already parsed the partial JSON. Send snapshots at ~30fps;
          // block.completed always delivers the final arguments without throttling.
          const now = Date.now();
          if (now - lastToolDeltaAt < 32) return;
          lastToolDeltaAt = now;
          protocolType = "message.delta";
          protocolPayload = {
            blockType: "tool-call", contentIndex: messageEvent.contentIndex,
            toolCallId: block?.id,
            toolName: toolNameByModelName.get(String(block?.name ?? "")) ?? block?.name,
            args: block?.arguments,
          };
        } else if (messageEvent?.type === "thinking_end") {
          protocolType = "message.block.completed";
          protocolPayload = { blockType: "reasoning", contentIndex: messageEvent.contentIndex };
        } else if (messageEvent?.type === "toolcall_end") {
          const toolCall = messageEvent.toolCall as { id?: string; name?: string; arguments?: unknown } | undefined ?? block;
          protocolType = "message.block.completed";
          protocolPayload = {
            blockType: "tool-call", contentIndex: messageEvent.contentIndex,
            toolCallId: toolCall?.id,
            toolName: toolNameByModelName.get(String(toolCall?.name ?? "")) ?? toolCall?.name,
            args: toolCall?.arguments,
          };
        } else return;
      } else if (e.type === "message_end") protocolType = "message.completed";
      else if (e.type === "turn_start") protocolType = "model.request.started";
      else if (e.type === "tool_execution_start") {
        protocolType = "tool.started";
        protocolPayload = { toolCallId: raw.toolCallId, parentToolCallId: raw.parentToolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, args: raw.args ?? raw.input };
      } else if (e.type === "tool_execution_update") {
        protocolType = "tool.updated";
        protocolPayload = { toolCallId: raw.toolCallId, parentToolCallId: raw.parentToolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, update: raw.partialResult ?? raw.update };
      } else if (e.type === "tool_execution_end") {
        const result = raw.result as { isError?: boolean } | undefined;
        const isError = e.isError || result?.isError === true;
        protocolType = isError ? "tool.failed" : "tool.completed";
        protocolPayload = { toolCallId: raw.toolCallId, parentToolCallId: raw.parentToolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, result: isError ? { ...result, isError: true } : raw.result, isError };
      } else if (e.type === "agent_start") protocolType = "turn.started";
      else if (e.type === "agent_end") protocolType = "turn.completed";
      else if (e.type === "entry_appended") {
        protocolType = "session.entry.appended";
        protocolPayload = { entry: raw.entry };
        this.hooks.onCustomEntry?.(eventSessionId, raw.entry);
      }
      this.push(protocolType, protocolPayload, eventSessionId, runId);
      const timing = responseTiming.record(protocolType, protocolPayload);
      if (timing) {
        this.push("model.response.timing", timing, eventSessionId, runId);
        log.info("model response timing", { sessionId: eventSessionId, runId, ...timing });
      }
      if (!runId) return;
      const p = normalized as { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; message?: unknown; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
      const toolPayload = protocolPayload as { toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
      const delta = p.assistantMessageEvent?.delta;
      if (p.assistantMessageEvent?.type === "text_delta" && typeof delta === "string" && delta) this.hooks.onMessage?.(eventSessionId, runId, "assistant", delta);
      if (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason !== "error" && e.message.stopReason !== "aborted") {
        const finalText = extractTextContent(raw.message);
        if (finalText) this.hooks.onAssistantFinal?.(eventSessionId, runId, finalText);
      }
      if (e.type === "tool_execution_start") {
        const name = toolNameByModelName.get(String(toolPayload.toolName ?? "")) ?? String(toolPayload.toolName ?? "tool");
        this.hooks.onTool?.(eventSessionId, runId, "start", name, toolPayload.args, undefined, toolPayload.toolCallId, String((toolPayload as { parentToolCallId?: unknown }).parentToolCallId ?? "") || undefined);
      }
      if (e.type === "tool_execution_end") {
        const name = toolNameByModelName.get(String(toolPayload.toolName ?? "")) ?? String(toolPayload.toolName ?? "tool");
        this.hooks.onTool?.(eventSessionId, runId, "end", name, toolPayload.args, toolPayload.result, toolPayload.toolCallId, String((toolPayload as { parentToolCallId?: unknown }).parentToolCallId ?? "") || undefined);
      }
    });

    this.sessions.set(sessionId, session);
    this.sessionSettingsManagers.set(sessionId, sessionSettings);
    return session;
  }

  approve(approvalId: string): boolean {
    const approved = this.approvals.approve(approvalId);
    if (approved) this.removePendingApproval(approvalId);
    return approved;
  }

  reject(approvalId: string): boolean {
    const rejected = this.approvals.reject(approvalId);
    if (rejected) this.removePendingApproval(approvalId);
    return rejected;
  }

  setPermissionMode(sessionId: string, mode: RunPermissionMode): void {
    this.runModes.set(sessionId, mode);
    const pending = this.pendingApprovalIds.get(sessionId);
    if (pending) for (const approvalId of pending) this.approvals.reevaluate(approvalId);
  }

  private removePendingApproval(approvalId: string): void {
    for (const [sessionId, pending] of this.pendingApprovalIds) {
      if (!pending.delete(approvalId)) continue;
      if (pending.size === 0) this.pendingApprovalIds.delete(sessionId);
      return;
    }
  }

  async run(
    sessionId: string,
    message: string,
    opts: { model?: string; cwd?: string; runId?: string; permissionMode?: RunPermissionMode; thinking?: RunThinkingLevel; attachments?: MessageAttachmentInfo[]; eventSessionId?: string; mcpServerId?: string; subagentDepth?: number; subagentRunId?: string; goalId?: string; goalEpoch?: number },
    runEmit: RunEmitFn
  ): Promise<void> {
    if (this.activeRunIds.has(sessionId) || this.compactingSessions.has(sessionId)) throw new Error(`session ${sessionId} already has an active run or compaction`);
    const runId = opts.runId ?? crypto.randomUUID();
    this.activeRunIds.set(sessionId, runId);
    const mediaController = new AbortController();
    this.mediaRunControllers.set(runId, mediaController);
    // Keep a mode selected immediately before the run starts. This also makes
    // the IPC update race safe when the UI changes the mode while the run
    // command is still entering the runtime.
    this.runModes.set(sessionId, opts.permissionMode ?? this.runModes.get(sessionId) ?? "ask");
    const configuredImageModel = opts.model ? this.imageModelConfigs.get(opts.model) : undefined;
    const configuredSpeechModel = opts.model ? this.speechModelConfigs.get(opts.model) : undefined;
    const configuredVideoModel = opts.model ? this.videoModelConfigs.get(opts.model) : undefined;
    let session: AgentSession | undefined;
    try {
      if (configuredImageModel) {
        if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
        await this.runImageGeneration(sessionId, runId, message, await materializeModelInputs(opts.attachments, true, ["image"]), configuredImageModel);
        runEmit("agent.prompt_done", { runId });
        return;
      }
      if (configuredSpeechModel) {
        if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
        await this.runSpeechGeneration(opts.eventSessionId ?? sessionId, runId, message, configuredSpeechModel);
        runEmit("agent.prompt_done", { runId });
        return;
      }
      if (configuredVideoModel) {
        if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
        await this.runVideoGeneration(opts.eventSessionId ?? sessionId, runId, message, configuredVideoModel);
        runEmit("agent.prompt_done", { runId });
        return;
      }
      session = await this.getSession(sessionId, opts.cwd, opts.model, opts.thinking, opts.eventSessionId ?? sessionId, opts.mcpServerId, opts.subagentDepth, opts.subagentRunId, opts.goalId, opts.goalEpoch, runId);
      if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
      this.runs.set(runId, session);
      const activeSession = session;
      const previousLength = session.messages.length;
      const selectedModel = opts.model
        ? this.modelRuntime?.getModel(...splitModelName(opts.model))
        : session.agent.state.model;
      const isGoogle = selectedModel?.api === "google-generative-ai";
      const isCompletions = selectedModel?.api === "openai-completions";
      const capabilities = selectedModel ? configuredCapabilities(this.configuredModelConfigs, `${selectedModel.provider}/${selectedModel.id}`) : undefined;
      const attachments = opts.attachments;
      const videoAttachmentNotice = this.rememberVideoAttachments(runId, attachments);
      const missingAttachmentInput = capabilities && attachments?.some((attachment) => !canProcessMediaAttachment(selectedModel!.api, capabilities.input, attachment));
      const nativeVideoAttachment = capabilities && attachments?.find((attachment) => attachment.mimeType.startsWith("video/") && !capabilities.input.includes("video"));
      const delegationPolicy = this.subagentPolicy?.();
      const canDelegate = this.delegateSubagent && (!opts.subagentRunId || (delegationPolicy?.allowNested ?? true))
        && (opts.subagentDepth ?? 0) < (delegationPolicy?.maxDepth ?? 3);
      const routingCandidates = (missingAttachmentInput || nativeVideoAttachment) && canDelegate ? this.subagentController?.catalog() : undefined;
      const videoRecognitionSubagent = nativeVideoAttachment && canDelegate && !opts.subagentRunId
        ? routingCandidates?.capabilities.find((candidate) => candidate.capability === "videoRecognition")
        : undefined;
      let automaticMediaDelegation: AutomaticMediaDelegation | undefined;
      if (nativeVideoAttachment && videoRecognitionSubagent && this.delegateSubagent) {
        try {
          const delegated = await this.delegateSubagent({
            capability: "videoRecognition", subagentId: null,
            parentSessionId: sessionId, parentRunId: runId,
            toolCallId: `media-routing-${runId}`,
            title: runtimeText("pi-adapter.video_recognition_subagent_title"),
            task: message,
            reason: runtimeText("pi-adapter.video_recognition_subagent_reason"),
            expectedResult: runtimeText("pi-adapter.video_recognition_subagent_expected_result"),
            mediaAttachment: nativeVideoAttachment,
            fallbackModel: opts.model,
            permissionMode: opts.permissionMode ?? "ask",
            background: false,
            signal: mediaController.signal,
          });
          automaticMediaDelegation = parseAutomaticMediaDelegation(delegated);
        } catch (error) {
          log.warn("automatic video subagent delegation failed", { runId, error: String(error) });
        }
      }
      const modelAttachments = automaticMediaDelegation
        ? attachments?.filter((attachment) => !attachment.mimeType.startsWith("video/"))
        : attachments;
      const delegatedMediaNotice = automaticMediaDelegation
        ? runtimeText("pi-adapter.video_recognition_subagent_result", { p0: automaticMediaDelegation.status, p1: automaticMediaDelegation.result })
        : "";
      const routingNotice = delegatedMediaNotice || (routingCandidates
        ? runtimeText("pi-adapter.the_current_model_cannot_directly_read_some_attachments_only", { p0: JSON.stringify(routingCandidates) })
        : missingAttachmentInput && !canDelegate
          ? runtimeText("pi-adapter.the_current_model_cannot_directly_read_some_attachments_and")
          : "");
      const modelInputs = await materializeModelInputs(modelAttachments, isGoogle, capabilities?.input);
      const webAccessContext = this.hooks.webAccessContext?.(opts.eventSessionId ?? sessionId, message) ?? "";
      await withMediaPhaseReporter((phase) => {
        if (isGoogle) this.push("media.phase", { phase: "provider-processing", status: phase }, opts.eventSessionId ?? sessionId, runId);
      }, () => activeSession.prompt([webAccessContext, capabilities ? mediaCapabilitiesContext(capabilities) : "", routingNotice, automaticMediaDelegation ? "" : videoAttachmentNotice, promptWithAttachments(message, modelAttachments, Boolean(capabilities?.input.includes("video") || capabilities?.input.includes("audio")), capabilities?.input)].filter(Boolean).join("\n"), {
        images: isGoogle ? googleMediaContent(modelInputs, capabilities?.input)
          : [...imageContent(modelInputs, capabilities?.input), ...(isCompletions ? googleMediaContent(modelInputs?.filter((item) => item.mimeType.startsWith("audio/")), capabilities?.input) : [])],
      }));
      const assistantMessages = session.messages.slice(previousLength).filter((item) => item.role === "assistant");
      const final = assistantMessages.at(-1);
      if (final?.stopReason === "error") throw new Error(final.errorMessage || "Model request failed");
      if (final?.stopReason === "aborted" && !this.stoppedRuns.has(runId)) throw new Error(final.errorMessage || "Model request aborted");
      runEmit("agent.prompt_done", { runId });
    } catch (error) {
      // Pi cannot resume this in-memory transcript after its compaction continuation
      // lands on an assistant message. Rebuild from persisted messages on the next run.
      if (String(error).includes("Cannot continue from message role: assistant")) this.staleSessions.add(sessionId);
      throw error;
    } finally {
      const directories = this.videoTempDirs.get(runId);
      this.videoTempDirs.delete(runId);
      this.downloadedVideoPaths.delete(runId);
      this.mediaAttachmentRefs.delete(runId);
      this.mediaRunControllers.delete(runId);
      if (directories) await Promise.all([...directories].map((directory) => rm(directory, { recursive: true, force: true }).catch((error) => log.warn("failed to clean downloaded video", { directory, error: String(error) }))));
      this.runs.delete(runId);
      this.runModes.delete(sessionId);
      this.pendingApprovalIds.delete(sessionId);
      this.stoppedRuns.delete(runId);
      if (this.activeRunIds.get(sessionId) === runId) this.activeRunIds.delete(sessionId);
      if (session && opts.mcpServerId) {
        await this.disposeSession(sessionId);
      } else if (session && this.staleSessions.has(sessionId) && session.isIdle) {
        await session.dispose();
        this.sessions.delete(sessionId);
        this.sessionSettingsManagers.delete(sessionId);
        this.staleSessions.delete(sessionId);
      }
    }
  }

  private async runImageGeneration(sessionId: string, runId: string, prompt: string, attachments: MessageAttachmentInfo[] | undefined, config: ModelConfigInfo): Promise<void> {
    const rawConfig = config.config && typeof config.config === "object" ? config.config : {};
    const detected = detectImageModel({
      model: config.model,
      provider: config.provider,
      apiType: typeof rawConfig.apiType === "string" ? rawConfig.apiType : undefined,
      imageApiFormat: typeof rawConfig.imageApiFormat === "string" ? rawConfig.imageApiFormat as ImageApiFormat : undefined,
      input: Array.isArray(rawConfig.input) ? rawConfig.input as string[] : undefined,
      output: Array.isArray(rawConfig.output) ? rawConfig.output as string[] : undefined,
      manualInput: Boolean(rawConfig.metadataOverrides && typeof rawConfig.metadataOverrides === "object" && (rawConfig.metadataOverrides as Record<string, unknown>).input === true),
      manualOutput: Boolean(rawConfig.metadataOverrides && typeof rawConfig.metadataOverrides === "object" && (rawConfig.metadataOverrides as Record<string, unknown>).output === true),
      metadata: rawConfig.modelMetadata && typeof rawConfig.modelMetadata === "object" ? rawConfig.modelMetadata as ModelMetadata : undefined,
    });
    if (!detected.isImageModel || !detected.format) throw new Error("Image model format could not be determined");
    const apiKey = this.modelApiKeys.get(config.provider);
    if (!apiKey) throw new Error(`No API key configured for image provider ${config.provider}`);
    const controller = new AbortController();
    this.generationRunControllers.set(runId, controller);
    this.push("message.started", { message: { role: "assistant" } }, sessionId, runId);
    try {
      const parts = await generateImage({ config, format: detected.format, prompt, attachments, apiKey, signal: controller.signal });
      this.push("message.completed", { message: { role: "assistant", content: parts } }, sessionId, runId);
    } finally {
      this.generationRunControllers.delete(runId);
    }
  }

  private async runSpeechGeneration(sessionId: string, runId: string, text: string, config: ModelConfigInfo): Promise<void> {
    const apiKey = this.modelApiKeys.get(config.provider);
    if (!apiKey) throw runtimeError("pi-adapter.no_api_key_configured_for_speech_provider", { p0: config.provider });
    if (!this.hooks.onGeneratedMedia) throw runtimeError("pi-adapter.speech_result_storage_is_not_initialized", {});
    const controller = new AbortController();
    this.generationRunControllers.set(runId, controller);
    this.push("message.started", { message: { role: "assistant" } }, sessionId, runId);
    try {
      const speech = await generateSpeech({ config, text, apiKey, signal: controller.signal });
      controller.signal.throwIfAborted();
      const savedPath = await this.hooks.onGeneratedMedia(sessionId, runId, speech.bytes, speech.mimeType, speech.extension, controller.signal);
      controller.signal.throwIfAborted();
      this.push("message.completed", { message: { role: "assistant", content: [{ type: "text", text: runtimeText("pi-adapter.speech_generated", { p0: savedPath }) }] } }, sessionId, runId);
    } finally {
      this.generationRunControllers.delete(runId);
    }
  }

  private async runVideoGeneration(sessionId: string, runId: string, prompt: string, config: ModelConfigInfo): Promise<void> {
    const apiKey = this.modelApiKeys.get(config.provider);
    if (!apiKey) throw runtimeError("pi-adapter.no_api_key_configured_for_video_provider", { p0: config.provider });
    if (!this.hooks.onGeneratedMedia) throw runtimeError("pi-adapter.video_result_storage_is_not_initialized", {});
    const controller = new AbortController();
    this.generationRunControllers.set(runId, controller);
    this.push("message.started", { message: { role: "assistant" } }, sessionId, runId);
    try {
      const video = await generateVideo({ config, prompt, apiKey, signal: controller.signal });
      controller.signal.throwIfAborted();
      const savedPath = await this.hooks.onGeneratedMedia(sessionId, runId, video.stream, video.mimeType, video.extension, controller.signal);
      controller.signal.throwIfAborted();
      this.push("message.completed", { message: { role: "assistant", content: [{ type: "text", text: runtimeText("pi-adapter.video_generated", { p0: savedPath }) }] } }, sessionId, runId);
    } finally {
      this.generationRunControllers.delete(runId);
    }
  }

  stopAll(): string[] {
    const runIds = [...this.activeRunIds.values()];
    for (const runId of runIds) this.stop(runId);
    return runIds;
  }

  stop(runId: string): boolean {
    const session = this.runs.get(runId);
    if (!session && ![...this.activeRunIds.values()].includes(runId)) return false;
    this.stoppedRuns.add(runId);
    this.mediaRunControllers.get(runId)?.abort();
    this.generationRunControllers.get(runId)?.abort();
    if (session) void session.abort();
    log.info("run aborted", { runId });
    return true;
  }

  hasSession(sessionId: string): boolean {
    return this.sessions.has(sessionId);
  }

  async waitForRun(runId: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while ([...this.activeRunIds.values()].includes(runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return ![...this.activeRunIds.values()].includes(runId);
  }

  /**
   * Queue an internal update at the next assistant-turn boundary. Pi's
   * follow-up queue waits until the agent stops calling tools, which places
   * completion acknowledgements after the final answer. Agent.steer() waits
   * for the current generation and tool batch without aborting either.
   *
   * Notification prompts are already expanded plain text, so they can use
   * Agent's synchronous queue API directly while retaining the same run and
   * streaming ownership checks as sendToSession().
   */
  queueSubagentUpdateNow(sessionId: string, message: string, expectedRunId = this.activeRunIds.get(sessionId)): boolean {
    const session = this.activeRunIds.has(sessionId) ? this.sessions.get(sessionId) : undefined;
    if (!session || !expectedRunId || this.activeRunIds.get(sessionId) !== expectedRunId
      || this.runs.get(expectedRunId) !== session || this.stoppedRuns.has(expectedRunId) || !session.isStreaming) return false;
    try {
      session.agent.steer({ role: "user", content: [{ type: "text", text: message }], timestamp: Date.now() });
      return true;
    } catch (error) {
      log.warn("failed to queue subagent update", { sessionId, runId: expectedRunId, error: String(error) });
      return false;
    }
  }

  async sendToSession(sessionId: string, message: string, mode: "steer" | "follow_up", attachments?: MessageAttachmentInfo[], expectedRunId = this.activeRunIds.get(sessionId)): Promise<boolean> {
    return this.sessionInputs.run(sessionId, async () => {
      const session = this.activeRunIds.has(sessionId) ? this.sessions.get(sessionId) : undefined;
      const isCurrentRun = () => Boolean(expectedRunId && this.activeRunIds.get(sessionId) === expectedRunId
        && this.sessions.get(sessionId) === session && !this.stoppedRuns.has(expectedRunId) && session?.isStreaming);
      if (!session || !isCurrentRun()) return false;
      const selectedModel = session.agent.state.model;
      const isGoogle = selectedModel?.api === "google-generative-ai";
      const isCompletions = selectedModel?.api === "openai-completions";
      const input = selectedModel ? configuredCapabilities(this.configuredModelConfigs, `${selectedModel.provider}/${selectedModel.id}`).input : undefined;
      const runId = this.activeRunIds.get(sessionId);
      const videoAttachmentNotice = runId ? this.rememberVideoAttachments(runId, attachments) : "";
      const modelAttachments = await materializeModelInputs(attachments, isGoogle, input);
      const prompt = [videoAttachmentNotice, promptWithAttachments(message, attachments, Boolean(input?.includes("video") || input?.includes("audio")), input)].filter(Boolean).join("\n");
      const images = isGoogle ? googleMediaContent(modelAttachments, input)
        : [...imageContent(modelAttachments, input), ...(isCompletions ? googleMediaContent(modelAttachments?.filter((item) => item.mimeType.startsWith("audio/")), input) : [])];
      // Materializing files can outlive the target run. Never leave an input in
      // an idle Pi session or accidentally deliver it to its replacement run.
      if (!isCurrentRun()) return false;
      if (mode === "steer") await session.steer(prompt, images);
      else await session.followUp(prompt, images);
      if (!isCurrentRun()) {
        // Pi's input handlers also await. Clear orphaned input only if this
        // still owns the session; a replacement run's queue belongs to it.
        const activeRun = this.activeRunIds.get(sessionId);
        if ((!activeRun || activeRun === expectedRunId) && this.sessions.get(sessionId) === session) session.clearQueue();
        return false;
      }
      return true;
    });
  }

  clearSessionQueue(sessionId: string): void { this.sessions.get(sessionId)?.clearQueue(); }
}
