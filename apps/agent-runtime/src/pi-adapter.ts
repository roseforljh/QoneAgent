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
import { rm } from "node:fs/promises";
import { detectImageModel, normalizeThinkingLevelForApi, supportsMemorySummary, type AgentEvent, type ImageApiFormat, type MessageAttachmentInfo, type ModelConfigInfo, type ProviderApiType, type RunPermissionMode, type RunThinkingLevel } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { subscribeSessionEvents } from "./pi-session-events.js";
import { installSubagentFinalizationGuard } from "./subagent-finalization-guard.js";
import { contextTokens, subscribeContextUsage } from "./context-usage.js";
import { SessionInputQueue } from "./session-input-queue.js";
import { SIDE_CHAT_INSTRUCTIONS } from "./side-conversation.js";
import { createFileChangeTools } from "./file-change-tools.js";
import { createMediaTools, createInternalTools, mediaToolHostFor } from "./pi-tool-kit.js";
import { ApprovalQueue, withPermission, type PermissionRuleStore } from "./permissions.js";
import { withBrowserSessionId } from "./app-opencli-bridge.js";
import { elevatedPowerShell } from "./elevated-powershell.js";
import { createResourceLoader, sessionResourceLoader } from "./skills.js";
import { runImageGeneration, runSpeechGeneration, runVideoGeneration, type GenerationContext } from "./media-generation-runner.js";
import { createSubagentTools } from "./subagent-tools.js";
import type { SubagentSelection } from "./subagent-selection.js";
import { googleMediaContent, isGoogleGeminiApi } from "./google-media.js";
import { createConfiguredModelStream } from "./pi-provider-stream.js";
import { ModelMetadataResolver } from "./model-resolver.js";
import { configuredCapabilities } from "./media-capabilities.js";
import { createPiSessionEntries, imageContent, materializeModelInputs, promptWithAttachments, videoAttachmentNotice, type PersistedPiMessage } from "./pi-attachments.js";
import type { DouyinBridge } from "./douyin-bridge.js";
import { assertModelToolNames, extractTextContent, fetchProviderModels, splitModelName } from "./pi-message-utils.js";
import { applyToolExposure, usedToolNames } from "./tool-exposure.js";
import { compactionReserveTokens, DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences, type PiCompactionPreferences } from "./pi-compaction.js";
import type { AppMediaService } from "./app-media-service.js";
import type { EmbeddedOpenCliRunner } from "./browser-sync.js";
import { promptPiRun } from "./pi-run-prompt.js";
import { executionContextExtension, type ServerExecutionTarget } from "./execution-context.js";
import { captureCompactedContext } from "./session-compaction.js";
import { cacheReportedIn, observeRequestUsage, observeStreamResult, usageFromResponse, type ProviderUsageReport } from "./usage-capture.js";
import { executionAdviceExtension } from "./execution-advice.js";
import { memoryDeliveryExtension, type MemoryAddition, type MemoryDelivery } from "./memory/memory-context.js";
import type { CacheObservation } from "@qone/protocol";
import type { BackgroundShellJobs } from "./background-shell.js";

const log = createLogger("pi-adapter");
export const PI_REQUEST_OVERRIDES = { httpIdleTimeoutMs: 0 } as const;
export { compactionReserveTokens, DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences } from "./pi-compaction.js";
export type { PiCompactionPreferences } from "./pi-compaction.js";

const isOfficialAnthropic = (model: { api: string; baseUrl: string }) =>
  model.api === "anthropic-messages" && model.baseUrl.includes("api.anthropic.com");

type EmitFn = (event: AgentEvent) => void;
type RunEmitFn = (type: string, payload: unknown) => void;
type DelegateSubagent = (input: SubagentSelection & { parentSessionId: string; parentRunId: string; parentSubagentId?: string; depth?: number; toolCallId: string; task: string; title: string; reason: string; expectedResult: string; mediaAttachment?: MessageAttachmentInfo & { temporary?: boolean }; fallbackModel?: string; permissionMode: RunPermissionMode; serverIds?: string[]; background?: boolean; signal?: AbortSignal }) => Promise<string>;
type SubagentController = import("./subagent-runner.js").SubagentController;

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
  onTool?: (sessionId: string, runId: string, phase: "start" | "update" | "end", name: string, args?: unknown, result?: unknown, toolCallId?: string, parentToolCallId?: string, durationMs?: number) => void;
  webAccessContext?: (sessionId: string, task?: string) => string;
  /** Long-term memory for top-level conversations only; side chats and subagents never read or write it. */
  memoryContext?: (sessionId: string, message: string, modelName?: string) => string;
  memoryAddition?: (sessionId: string, runId: string, delivery: MemoryDelivery) => MemoryAddition | undefined;
  memoryTools?: (sessionId: string) => ToolDefinition[];
  /** Raw provider usage for the execution statistics page; exactly once per completed model request. */
  usageObserved?: (sessionId: string | undefined, usage: ProviderUsageReport, source: "chat" | "memory" | "other") => void;
  executionAdvice?: (provider: string, model: string, tool: string, input: unknown) => string | undefined;
  executionModel?: (runId: string, model: string) => void;
  /** The chat a side conversation was opened from, so its usage is not lost or misattributed. */
  sideConversationOwner?: (sideSessionId: string) => string | undefined;
  deliveryTools?: (sessionId: string, workspacePath: string, activeRunId: () => string | undefined) => ToolDefinition[];
  /** The user's SSH servers; they go through the normal approval wrapper. */
  serverTools?: (workspacePath: string, serverIds: readonly string[]) => ToolDefinition[];
  serverSummary?: (serverIds: readonly string[]) => string;
  serverTargets?: (serverIds: readonly string[]) => ServerExecutionTarget[];
  onCustomEntry?: (sessionId: string, entry: unknown) => void;
  onAutomaticCompaction?: (sessionId: string, runId: string, context: unknown[]) => void;
  onGeneratedMedia?: (sessionId: string, runId: string, data: Uint8Array | ReadableStream<Uint8Array>, mimeType: string, extension: string, signal: AbortSignal) => Promise<string>;
}

export class PiAdapter {
  private isSideConversation: (sessionId: string) => boolean = () => false;
  setSideConversationResolver(resolve: (sessionId: string) => boolean) { this.isSideConversation = resolve; }
  private emit: EmitFn;
  private sessions = new Map<string, AgentSession>();
  private runs = new Map<string, AgentSession>();
  private activeRunIds = new Map<string, string>();
  private readonly sessionInputs = new SessionInputQueue();
  private runModes = new Map<string, RunPermissionMode>();
  private sessionEpochs = new Map<string, object>();
  private stoppedRuns = new Set<string>();
  private forceRejects = new Map<string, (reason: Error) => void>();
  private seq = 0;
  private customTools: ToolDefinition[] = [];
  /** On-demand tool catalog of each live session, and the copy its model has already seen. */
  private toolCatalogs = new WeakMap<AgentSession, string>();
  private serverScopes = new WeakMap<AgentSession, string>();
  private sentToolCatalogs = new WeakMap<AgentSession, string>();
  private staleSessions = new Set<string>();
  private approvals = new ApprovalQueue();
  private pendingApprovalIds = new Map<string, Set<string>>();
  private hooks: PiAdapterHooks;
  private delegateSubagent?: DelegateSubagent;
  private subagentController?: SubagentController;
  private backgroundShell?: BackgroundShellJobs;
  private subagentPolicy?: () => { allowNested: boolean; maxDepth: number; maxConcurrent: number };
  private resourceLoaders = new Map<string, ResourceLoader>();
  private resourceLoaderLoads = new Map<string, Promise<ResourceLoader>>();
  private sessionResourceKeys = new Map<string, string>();
  private modelRuntime?: ModelRuntime;
  private modelRuntimeLoad?: Promise<ModelRuntime>;
  private async ensureModelRuntime(): Promise<ModelRuntime> {
    if (this.modelRuntime) return this.modelRuntime;
    const loading = this.modelRuntimeLoad ??= ModelRuntime.create({ allowModelNetwork: false });
    try { return this.modelRuntime ??= await loading; }
    finally { if (this.modelRuntimeLoad === loading) this.modelRuntimeLoad = undefined; }
  }
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
  private sessionFinalizers = new WeakMap<AgentSession, (runId: string) => void>();
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
  private memoryDeliveries = new Map<string, () => MemoryAddition | undefined>();
  private modelMetadataResolver = new ModelMetadataResolver({ providerModelsFetcher: fetchProviderModels });

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
        await this.disposeSession(sessionId);
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

  setBackgroundShell(jobs: BackgroundShellJobs) {
    this.backgroundShell = jobs;
  }

  setSubagentPolicy(policy: () => { allowNested: boolean; maxDepth: number; maxConcurrent: number }) {
    this.subagentPolicy = policy;
  }

  setGoalBridge(bridge: GoalRuntimeBridge) {
    this.goalBridge = bridge;
  }

  async refreshSkills(): Promise<void> {
    this.resourceLoaders.clear();
    this.resourceLoaderLoads.clear();
    await this.invalidateSessions();
  }

  /** Rebuild sessions on their next run, e.g. after their tool set changes. Active runs are not interrupted. */
  async invalidateSessions(): Promise<void> {
    for (const [sessionId, session] of this.sessions) {
      if (session.isIdle) {
        await this.disposeSession(sessionId);
      } else {
        this.staleSessions.add(sessionId);
      }
    }
  }

  private async applyModelConfiguration(configs: ModelConfigInfo[]): Promise<void> {
    this.modelRuntime = await this.ensureModelRuntime();
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
        // Vertex Gemini is a conversation transport, not a Developer API media-generation endpoint.
        if (resolved[index]!.api === "google-vertex") continue;
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
      const streamConfiguredModel = createConfiguredModelStream();
      this.modelRuntime.registerProvider(provider, {
        name: provider,
        baseUrl: firstResolved.baseUrl,
        api: firstResolved.api as never,
        streamSimple: (model, context, options) => streamConfiguredModel(model, context, options,
          configuredCapabilities(this.configuredModelConfigs, `${model.provider}/${model.id}`).input),
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
            // Pi enables Anthropic message threads only for its own "anthropic" provider id;
            // Qone provider ids are user-defined, so opt in for the official endpoint here.
            ...(model.compat || isOfficialAnthropic(model) ? { compat: { ...(isOfficialAnthropic(model) ? { supportsMessageThreads: true } : {}), ...model.compat } } : {}),
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
    this.sessionEpochs.delete(sessionId);
    const session = this.sessions.get(sessionId);
    this.sessions.delete(sessionId);
    this.sessionSettingsManagers.delete(sessionId);
    this.staleSessions.delete(sessionId);
    const key = this.sessionResourceKeys.get(sessionId);
    this.sessionResourceKeys.delete(sessionId);
    if (key && ![...this.sessionResourceKeys.values()].includes(key)) {
      this.resourceLoaders.delete(key);
      this.resourceLoaderLoads.delete(key);
    }
    if (session) await session.dispose();
  }

  getSessions(): AgentSession[] { return [...this.sessions.values()]; }

  /** Store credentials only in the live process and hand them to Pi's
   * provider runtime. The desktop persists the same value in Credential
   * Manager; it is never written to SQLite. */
  async setSecret(key: string, value: string): Promise<void> {
    const provider = key.startsWith("model.apiKey:") ? key.slice("model.apiKey:".length) : key;
    if (key.startsWith("model.apiKey:")) this.modelApiKeys.set(provider, value);
    this.modelRuntime = await this.ensureModelRuntime();
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
        return captureCompactedContext(session);
      } finally {
        settings.applyOverrides({ compaction: { keepRecentTokens } });
      }
    } finally {
      this.compactingSessions.delete(sessionId);
      if (this.restoreMessages && !this.isRunning(sessionId)) await this.disposeSession(sessionId);
    }
  }

  async getContextUsage(sessionId: string, cwd: string, modelName: string): Promise<{ tokens: number; contextWindow: number }> {
    const [provider, modelId] = splitModelName(modelName);
    this.modelRuntime = await this.ensureModelRuntime();
    const model = this.modelRuntime.getModel(provider, modelId);
    if (!model) throw new Error(`configured model not found: ${modelName}`);
    const existing = this.sessions.get(sessionId);
    if (!existing && this.isRunning(sessionId)) throw new Error("session context is not ready yet");
    const session = existing && !(this.staleSessions.has(sessionId) && existing.isIdle)
      ? existing
      : await this.getSession(sessionId, cwd, modelName);
    try {
      return { tokens: contextTokens(session), contextWindow: model.contextWindow };
    } finally {
      if (this.restoreMessages && session.isIdle && !this.isRunning(sessionId)) await this.disposeSession(sessionId);
    }
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
    this.modelRuntime = await this.ensureModelRuntime();
    const model = modelName
      ? this.modelRuntime.getModel(...splitModelName(modelName))
      : this.modelRuntime.getModels()[0];
    if (!model) throw new Error("no configured model available for title generation");
    // A title is a real model request, so it lands on the statistics page as `other`; otherwise
    // recorded tokens would not match what the provider actually billed.
    let cache: CacheObservation = "unknown";
    const response = await this.modelRuntime.completeSimple(model, {
      systemPrompt: "Generate a concise conversation title from the user's first message. Return only valid JSON with one string field named title. The title must be a short topic, never an answer to the user. Keep it under 8 words in English or 20 Chinese characters.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, { maxTokens: 32, temperature: 0.2, signal, onProviderStreamEvent: (data) => {
      if (cache === "unknown" && cacheReportedIn(String(model.api), data)) cache = "reported";
    } });
    try {
      const usage = usageFromResponse(model, response.usage, cache);
      if (usage) this.hooks.usageObserved?.(undefined, usage, "other");
    } catch { /* Telemetry must never break title generation. */ }
    const title = extractTextContent(response)
      .replace(/[\r\n]+/g, " ")
      .replace(/^['"“”‘’`]+|['"“”‘’`]+$/g, "")
      .replace(/\s+/g, " ")
      .trim();
    if (!title) throw new Error("model returned an empty title");
    return title.slice(0, 80);
  }

  /** Tool-free memory completion; at startup, credentials may not be restored yet. */
  async completeText(modelId: string | undefined, preferredModel: string | undefined, systemPrompt: string, prompt: string, maxTokens: number, signal: AbortSignal): Promise<{ text: string; tokens: number }> {
    await this.modelConfigurationQueue;
    signal.throwIfAborted();
    const runtime = await this.ensureModelRuntime();
    const models = this.configuredModelConfigs.filter(config => supportsMemorySummary(config) && !this.isDirectGenerationModel(config.id) && runtime.hasConfiguredAuth(config.provider));
    // An explicit selection authorizes only that provider/model for conversation history.
    const configured = modelId ? models.find(config => config.id === modelId)
      : models.find(config => config.id === preferredModel || `${config.provider}/${config.model}` === preferredModel) ?? models[0];
    const model = configured && runtime.getModel(configured.provider, configured.model);
    if (!model) throw new Error(modelId ? `configured memory model unavailable: ${modelId}` : "no authenticated text model available for memory");
    // The same per-request rule as a chat turn: the request's own chunks mark the
    // cache flag and the final response carries the numbers, reported once.
    let cache: CacheObservation = "unknown";
    const response = await runtime.completeSimple(model, {
      systemPrompt,
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, { maxTokens, signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]), onProviderStreamEvent: (data) => {
      if (cache === "unknown" && cacheReportedIn(String(model.api), data)) cache = "reported";
    } });
    try {
      const usage = usageFromResponse(model, response.usage, cache);
      if (usage) this.hooks.usageObserved?.(undefined, usage, "memory");
    } catch { /* Telemetry must never break memory. */ }
    if (response.stopReason === "error" || response.stopReason === "aborted") throw new Error(response.errorMessage || "model request failed");
    return { text: extractTextContent(response), tokens: response.usage.totalTokens || response.usage.input + response.usage.output };
  }

  /**
   * Hands the request the observed options and reports its finished usage once. The value the
   * provider returns is passed through untouched, so the agent loop keeps iterating a stream.
   */
  private observeStream<T>(call: (options: unknown) => T, observed: ReturnType<typeof observeRequestUsage>): T {
    const value = call(observed);
    if (value instanceof Promise) return value.then((resolved) => { observeStreamResult(resolved as never, observed); return resolved; }) as T;
    observeStreamResult(value as never, observed);
    return value;
  }

  private push(type: string, payload: unknown, sessionId: string, runId?: string) {
    if (runId && !this.forceRejects.has(runId)) return;
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

  private getSession(...args: Parameters<PiAdapter["createSession"]>): Promise<AgentSession> {
    const runId = this.activeRunIds.get(args[0]), owner = runId ? this.forceRejects.get(runId) : undefined;
    const isCurrent = () => !runId || this.activeRunIds.get(args[0]) === runId && this.forceRejects.get(runId) === owner;
    return this.sessionInputs.run(args[0], () => {
      if (!isCurrent()) throw new Error("run aborted");
      return this.createSession(...args).catch(async error => {
        if (!this.sessions.has(args[0]) && isCurrent()) await this.disposeSession(args[0]);
        throw error;
      });
    });
  }
  private async createSession(sessionId: string, cwd?: string, modelName?: string, thinkingOverride?: RunThinkingLevel, eventSessionId = sessionId, mcpServerId?: string, subagentDepth = 0, subagentRunId?: string, goalId?: string, goalEpoch?: number, goalRunId?: string, serverIds?: string[]): Promise<AgentSession> {
    const scope = [...new Set(serverIds ?? [])].sort();
    const scopeKey = JSON.stringify(scope);
    const modelKey = modelName ? splitModelName(modelName).join("/") : undefined;
    const apiType = modelKey ? this.modelApiTypes.get(modelKey) : undefined;
    const override = thinkingOverride ? normalizeThinkingLevelForApi(thinkingOverride, apiType) : undefined;
    const thinking = override ? (override === "none" ? "off" : override) : modelName ? this.thinkingLevelForModel(modelName) : undefined;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (mcpServerId && !existing.isIdle) throw new Error("session is busy");
      if ((mcpServerId || this.staleSessions.has(sessionId) || (serverIds !== undefined && this.serverScopes.get(existing) !== scopeKey)) && existing.isIdle) {
        await this.disposeSession(sessionId);
      } else {
      if (modelName) {
        this.modelRuntime = await this.ensureModelRuntime();
        const [provider, modelId] = splitModelName(modelName);
        const nextModel = this.modelRuntime.getModel(provider, modelId);
        if (!nextModel) throw new Error(`configured model not found: ${modelName}`);
        const currentModel = existing.agent.state.model;
        if (currentModel && `${currentModel.provider}/${currentModel.id}` !== modelName && existing.isIdle) {
          await this.disposeSession(sessionId);
          return this.createSession(sessionId, cwd, modelName, thinkingOverride, eventSessionId, mcpServerId, subagentDepth, subagentRunId, goalId, goalEpoch, goalRunId, serverIds);
        }
        await existing.setModel(nextModel);
         if (thinking) existing.setThinkingLevel(thinking);
      }
      return existing;
      }
    }

    const epoch = {};
    this.sessionEpochs.set(sessionId, epoch);
    const isCurrent = () => this.sessionEpochs.get(sessionId) === epoch;
    const workspacePath = cwd ?? process.cwd();
    const sideConversation = this.isSideConversation(sessionId);
    const resourceKey = sideConversation
      ? `${subagentDepth > 0 ? "subagent-side-chat" : "side-chat"}:${sessionId}`
      : subagentDepth > 0 ? `subagent:${workspacePath}` : workspacePath;
    this.sessionResourceKeys.set(sessionId, resourceKey);
    let resourceLoader = this.resourceLoaders.get(resourceKey);
    if (!resourceLoader) {
      let loading = this.resourceLoaderLoads.get(resourceKey);
      if (!loading) {
        loading = createResourceLoader(workspacePath, sideConversation ? SIDE_CHAT_INSTRUCTIONS : undefined, true, subagentDepth > 0)
          .then(({ loader }) => loader);
        this.resourceLoaderLoads.set(resourceKey, loading);
      }
      try {
        resourceLoader = await loading;
        if (this.resourceLoaderLoads.get(resourceKey) === loading) this.resourceLoaders.set(resourceKey, resourceLoader);
      } finally {
        if (this.resourceLoaderLoads.get(resourceKey) === loading) this.resourceLoaderLoads.delete(resourceKey);
      }
    }
    if (!isCurrent()) throw new Error("run aborted");
    const powershell = createPowerShellTool(workspacePath, {
      operations: elevatedPowerShell,
      // PowerShell 7 can emit ANSI color codes for formatted objects. The
      // tool output is sent to the chat as plain text, so those codes would
      // become visible as garbled characters instead of colors.
      spawnHook: ({ command, ...context }) => ({
        ...context,
        command: "try { $PSStyle.OutputRendering = 'PlainText' } catch {}\n" + command,
      }),
    });
    Object.assign(powershell, { promptGuidelines: [
      ...((powershell as ToolDefinition).promptGuidelines ?? []),
      "Keep long-running tests and builds streaming: run commands directly rather than adding buffering pipelines such as Select-Object -Last or tail just to shorten output. The tool already truncates output and saves the full log. Preserve pipelines explicitly requested by the user.",
    ] });
    // A background result is delivered as a new turn of this conversation, so only
    // top-level chats can start one; a subagent or side chat has no turn to wake.
    const backgroundShell = subagentDepth === 0 && !sideConversation && !mcpServerId ? this.backgroundShell : undefined;
    const builtinTools = [
      createReadTool(workspacePath),
      backgroundShell ? backgroundShell.wrap(powershell as ToolDefinition, eventSessionId) : powershell,
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
      serverIds: scope,
      mediaMimeType: (runId, mediaPath) => this.downloadedVideoPaths.get(runId)?.get(mediaPath),
    });
    const mediaTools = createMediaTools(mediaToolHostFor({
      activeRunIds: this.activeRunIds,
      sessions: this.sessions as never,
      configuredModelConfigs: this.configuredModelConfigs,
      downloadedVideoPaths: this.downloadedVideoPaths,
      mediaAttachmentRefs: this.mediaAttachmentRefs,
      videoTempDirs: this.videoTempDirs,
      douyinBridge: this.douyinBridge,
      appMediaService: this.appMediaService,
      openCli: this.openCli,
      registerMediaDirectory: (runId, directory) => this.registerMediaDirectory(runId, directory),
    }, sessionId), workspacePath, modelName);
    const memoryTools = sideConversation || subagentDepth > 0 || mcpServerId ? [] : this.hooks.memoryTools?.(sessionId) ?? [];
    const deliveryTools = subagentDepth > 0 || mcpServerId ? [] : this.hooks.deliveryTools?.(eventSessionId, workspacePath, () => this.activeRunIds.get(sessionId)) ?? [];
    const internalTools = [...createInternalTools(this.goalBridge, eventSessionId, goalId, goalEpoch, goalRunId), ...memoryTools, ...deliveryTools, ...(backgroundShell ? [backgroundShell.tool(eventSessionId)] : [])];
    const internalToolNames = new Set(internalTools.map((tool) => tool.name));
    internalToolNames.add("finalize_response");
    const serverTools = mcpServerId ? [] : this.hooks.serverTools?.(workspacePath, scope) ?? [];
    // 确保内置浏览器与 OpenCLI 工具在 codemode 等异步调用路径中始终携带当前会话 ID。
    const withBrowserSession = (tool: ToolDefinition): ToolDefinition => (
      tool.name.startsWith("qone_browser_") || tool.name.startsWith("qone_opencli_") || tool.name.startsWith("qone_twitter_")
        ? { ...tool, execute: (...args) => withBrowserSessionId(eventSessionId ?? sessionId, () => tool.execute(...args)) }
        : tool
    );
    const wrapped = [...builtinTools, ...customTools, ...subagentTools, ...mediaTools, ...serverTools, ...internalTools].map((t) =>
      withPermission(withBrowserSession(t), {
        queue: this.approvals,
        workspacePath,
        rules: this.permissionRules,
        mode: () => this.runModes.get(sessionId) ?? "ask",
        internal: internalToolNames.has(t.name),
        isActive: isCurrent,
        emitApproval: (approvalId, toolName, args, toolCallId) => {
          if (!isCurrent()) { this.approvals.reject(approvalId); return; }
          const pending = this.pendingApprovalIds.get(sessionId) ?? new Set<string>();
          pending.add(approvalId);
          this.pendingApprovalIds.set(sessionId, pending);
          this.push("approval.requested", { approvalId, toolName, args, toolCallId }, eventSessionId, this.activeRunIds.get(sessionId));
        },
        emitResolved: (approvalId, toolCallId, approved) => {
          this.removePendingApproval(approvalId);
          if (!isCurrent()) return;
          this.push("approval.resolved", { approvalId, toolCallId, approved }, eventSessionId, this.activeRunIds.get(sessionId));
        },
      })
    );
    assertModelToolNames(wrapped.map((tool) => tool.name));
    // Integrations load on demand (tool_search / codemode); see tool-exposure.ts.
    // A session bound to one MCP server exists to call exactly those tools: keep them declared.
    const loadout = mcpServerId ? { tools: wrapped, catalog: "" }
      : applyToolExposure(wrapped, { name: "servers", description: this.hooks.serverSummary?.(scope) ?? "SSH servers" });

    const toolNameByModelName = new Map(wrapped.map((tool) => [
      tool.name,
      (tool as ToolDefinition & { qoneToolName?: string }).qoneToolName ?? tool.name,
    ]));

    let modelRuntime: ModelRuntime | undefined;
    let model: ReturnType<ModelRuntime["getModel"]> | undefined;
    if (modelName) {
      this.modelRuntime = await this.ensureModelRuntime();
      modelRuntime = this.modelRuntime;
      const [provider, modelId] = splitModelName(modelName);
      model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`configured model not found: ${modelName}`);
    }
    const restoredMessages = this.restoreMessages?.(sessionId, this.activeRunIds.get(sessionId)) ?? [];
    const preparedMessages = await Promise.all(restoredMessages.map(async (message) => ({
      ...message,
      attachments: message.role === "user"
        ? await materializeModelInputs(message.attachments, isGoogleGeminiApi(model?.api), model ? configuredCapabilities(this.configuredModelConfigs, `${model.provider}/${model.id}`).input : undefined, true)
        : message.attachments,
    })));
    const sessionManager = SessionManager.inMemory(
      workspacePath,
      undefined,
      createPiSessionEntries(workspacePath, preparedMessages, model,
        model ? configuredCapabilities(this.configuredModelConfigs, `${model.provider}/${model.id}`).input : undefined,
        sessionId),
    );
    const sessionSettings = SettingsManager.inMemory();
    sessionSettings.applyOverrides(this.compactionOverrides());
    // Let the provider and SDK decide when a request has failed. A value of 0
    // disables pi-coding-agent's HTTP idle timeout; local tool timeouts stay
    // independent of model request lifetime.
    sessionSettings.applyOverrides(PI_REQUEST_OVERRIDES);
    const { session } = await createAgentSession({
      cwd: workspacePath,
      sessionManager,
      noTools: "builtin", tools: ["+codemode", "+tool_search"],
      customTools: loadout.tools,
      resourceLoader: await sessionResourceLoader(resourceLoader, workspacePath, true, [
        executionContextExtension({ localTools: builtinTools.map(tool => tool.name), serverTools: serverTools.map(tool => tool.name), servers: () => mcpServerId ? [] : this.hooks.serverTargets?.(scope) ?? [] }),
        ...(this.hooks.executionAdvice ? [executionAdviceExtension(this.hooks.executionAdvice)] : []),
        ...(this.hooks.memoryAddition ? [memoryDeliveryExtension(() => {
          const runId = this.activeRunIds.get(sessionId);
          if (!runId || !isCurrent()) return;
          const delivery = this.memoryDeliveries.get(runId);
          this.memoryDeliveries.delete(runId);
          return delivery?.();
        })] : []),
      ]),
      modelRuntime,
      settingsManager: sessionSettings,
      model,
      thinkingLevel: thinking,
    });
    await session.bindExtensions({}).catch(async (error) => { await session.dispose(); throw error; });
    if (!isCurrent()) { session.dispose(); throw new Error("run aborted"); }
    // A side chat has no statistics row of its own; its requests belong to the conversation it
    // was opened from. A run starts after this session's messages are restored, so this one
    // lookup is the request's owner for every request this session makes afterwards.
    const usageSessionId = sideConversation ? this.hooks.sideConversationOwner?.(sessionId) ?? eventSessionId : eventSessionId;
    // Wrap the per-request scope: this request's raw chunks mark its cache flag and its
    // finished result reports once. The stream object itself is returned untouched, so
    // the agent loop's `for await (... of response)` keeps working exactly as before.
    const originalStream = session.agent.streamFunction;
    const reportUsage = (usage: ProviderUsageReport) => this.hooks.usageObserved?.(usageSessionId, usage, mcpServerId || subagentRunId || sideConversation ? "other" : "chat");
    session.agent.streamFunction = (streamModel, context, options) => {
      const observed = observeRequestUsage(String(streamModel.api), streamModel, options, reportUsage);
      const stream = this.observeStream(
        (next) => originalStream(streamModel, context, next as Parameters<typeof originalStream>[2]),
        observed);
      return stream;
    };
    // Qone rebuilds sessions from its own message store, which does not keep Pi's
    // loadout entries. Re-declare on-demand tools the restored history already used.
    const deferred = new Set(loadout.tools.filter((tool) => (tool as { exposure?: string }).exposure === "deferred").map((tool) => tool.name));
    const reload = [...usedToolNames(restoredMessages.map((message) => message.rawMessage))].filter((name) => deferred.has(name));
    if (reload.length) session.setActiveToolsByName([...session.getActiveToolNames(), ...reload]);
    installSubagentFinalizationGuard(session, {
      runId: () => this.activeRunIds.get(sessionId),
      controller: () => this.subagentController,
      push: (type, payload, fromSessionId, runId) => this.push(type, payload, fromSessionId ?? sessionId, runId),
      eventSessionId,
    });
    try {
      assertModelToolNames(session.getActiveToolNames());
    } catch (error) {
      await session.dispose();
      throw error;
    }

    const onAutomaticCompaction = this.hooks.onAutomaticCompaction;
    if (onAutomaticCompaction && eventSessionId === sessionId && !subagentRunId) session.subscribe((event) => {
      if (event.type !== "compaction_end" || !event.result || event.aborted || event.reason === "manual" || !isCurrent()) return;
      const runId = this.activeRunIds.get(sessionId);
      if (runId && this.runs.get(runId) === session) onAutomaticCompaction(sessionId, runId, captureCompactedContext(session));
    });
    if (eventSessionId === sessionId) subscribeContextUsage(session, (usage) => {
      if (!isCurrent()) return;
      const activeModel = session.model;
      const model = this.configuredModelConfigs.find((config) => config.provider === activeModel?.provider && config.model === activeModel?.id)?.id;
      if (model) this.push("context.usage", { model, ...usage }, sessionId, this.activeRunIds.get(sessionId));
    });
    this.sessionFinalizers.set(session, subscribeSessionEvents({
      sessionId, eventSessionId, session, runs: this.runs, activeRunIds: this.activeRunIds, isCurrent,
      toolNameByModelName, hooks: this.hooks,
      push: (type, payload, fromSessionId, runId) => this.push(type, payload, fromSessionId, runId),
    }));

    this.sessions.set(sessionId, session);
    this.sessionSettingsManagers.set(sessionId, sessionSettings);
    this.toolCatalogs.set(session, loadout.catalog);
    this.serverScopes.set(session, scopeKey);
    if (loadout.catalog && restoredMessages.some(message => extractTextContent(message.rawMessage).includes(loadout.catalog))) this.sentToolCatalogs.set(session, loadout.catalog);
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
    opts: { serverIds?: string[]; model?: string; cwd?: string; runId?: string; permissionMode?: RunPermissionMode; thinking?: RunThinkingLevel; attachments?: MessageAttachmentInfo[]; eventSessionId?: string; mcpServerId?: string; subagentDepth?: number; subagentRunId?: string; goalId?: string; goalEpoch?: number; memoryUserMessage?: string },
    runEmit: RunEmitFn
  ): Promise<void> {
    if (this.activeRunIds.has(sessionId) || this.compactingSessions.has(sessionId)) throw new Error(`session ${sessionId} already has an active run or compaction`);
    const runId = opts.runId ?? crypto.randomUUID();
    this.activeRunIds.set(sessionId, runId);
    // A forced stop settles the run at once, even while a tool ignores its abort signal.
    let rejectForce!: (reason: Error) => void;
    const forced = new Promise<never>((_resolve, reject) => { rejectForce = reject; this.forceRejects.set(runId, reject); });
    try {
      await Promise.race([this.execute(sessionId, runId, message, opts, (type, payload) => {
        if (this.forceRejects.get(runId) === rejectForce && this.activeRunIds.get(sessionId) === runId) runEmit(type, payload);
      }), forced]);
    } finally {
      if (this.forceRejects.get(runId) === rejectForce) this.forceRejects.delete(runId);
    }
  }

  private async execute(
    sessionId: string,
    runId: string,
    message: string,
    opts: Parameters<PiAdapter["run"]>[2],
    runEmit: RunEmitFn,
  ): Promise<void> {
    const mediaController = new AbortController();
    this.mediaRunControllers.set(runId, mediaController);
    // Keep the selected mode ordered with IPC entry into the run.
    this.runModes.set(sessionId, opts.permissionMode ?? this.runModes.get(sessionId) ?? "ask");
    const configuredImageModel = opts.model ? this.imageModelConfigs.get(opts.model) : undefined;
    const configuredSpeechModel = opts.model ? this.speechModelConfigs.get(opts.model) : undefined;
    const configuredVideoModel = opts.model ? this.videoModelConfigs.get(opts.model) : undefined;
    let session: AgentSession | undefined;
    try {
      if (configuredImageModel) {
        if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
        const modelInputs = await materializeModelInputs(opts.attachments, true, ["image"]);
        mediaController.signal.throwIfAborted();
        await this.runImageGeneration(sessionId, runId, message, modelInputs, configuredImageModel);
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
      session = await this.getSession(sessionId, opts.cwd, opts.model, opts.thinking, opts.eventSessionId ?? sessionId, opts.mcpServerId, opts.subagentDepth, opts.subagentRunId, opts.goalId, opts.goalEpoch, runId, opts.serverIds ?? []);
      mediaController.signal.throwIfAborted();
      this.runs.set(runId, session);
      const previousAssistants = new Set(session.messages.filter((item) => item.role === "assistant"));
      const selectedModel = session.agent.state.model;
      if (selectedModel) this.hooks.executionModel?.(runId, `${selectedModel.provider}/${selectedModel.id}`);
      const capabilities = selectedModel ? configuredCapabilities(this.configuredModelConfigs, `${selectedModel.provider}/${selectedModel.id}`) : undefined;
      const policy = this.subagentPolicy?.();
      const canDelegate = Boolean(this.delegateSubagent && (!opts.subagentRunId || (policy?.allowNested ?? true)) && (opts.subagentDepth ?? 0) < (policy?.maxDepth ?? 3));
      const catalog = this.toolCatalogs.get(session) ?? "";
      const toolCatalog = catalog && this.sentToolCatalogs.get(session) !== catalog ? catalog : "";
      if (toolCatalog) this.sentToolCatalogs.set(session, catalog);
      const memoryAllowed = !opts.subagentRunId && !opts.mcpServerId && !this.isSideConversation(sessionId);
      if (memoryAllowed && opts.memoryUserMessage !== undefined && this.hooks.memoryAddition) {
        const current = session;
        this.memoryDeliveries.set(runId, () => !mediaController.signal.aborted ? this.hooks.memoryAddition!(sessionId, runId, {
          retained: current.messages.filter(({ role }) => role === "user"),
          rules: [...current.resourceLoader.getAgentsFiles().agentsFiles.map(({ content }) => content), ...current.resourceLoader.getAppendSystemPrompt()],
        }) : undefined);
      }
      await promptPiRun({
        sessionId, runId, message, session, opts, capabilities, canDelegate,
        delegate: this.delegateSubagent, catalog: this.subagentController?.catalog?.(),
        videoNotice: this.rememberVideoAttachments(runId, opts.attachments), toolCatalog,
        webContext: () => this.hooks.webAccessContext?.(opts.eventSessionId ?? sessionId, message) ?? "",
        memoryContext: () => memoryAllowed ? this.hooks.memoryContext?.(sessionId, opts.memoryUserMessage ?? "", opts.model) ?? "" : "",
        signal: mediaController.signal,
        phase: phase => this.push("media.phase", { phase: "provider-processing", status: phase }, opts.eventSessionId ?? sessionId, runId),
      });
      // Compaction can shrink the transcript below its initial length mid-run.
      const final = session.messages.filter((item) => item.role === "assistant").at(-1);
      if (final && !previousAssistants.has(final)) {
        // Usage is taken once per completed turn by the stream wrapper, whatever the
        // stop reason: a failed request still consumed tokens.
        if (final.stopReason === "error") throw new Error(final.errorMessage || "Model request failed");
        if (final.stopReason === "aborted" && !this.stoppedRuns.has(runId)) throw new Error(final.errorMessage || "Model request aborted");
      }
      runEmit("agent.prompt_done", { runId });
    } catch (error) {
      // Pi cannot resume this in-memory transcript after its compaction continuation
      // lands on an assistant message. Rebuild from persisted messages on the next run.
      if (this.activeRunIds.get(sessionId) === runId && String(error).includes("Cannot continue from message role: assistant")) this.staleSessions.add(sessionId);
      throw error;
    } finally {
      // Child resume reuses a run id; identity, not the id alone, owns these maps.
      if (this.mediaRunControllers.get(runId) === mediaController) {
        const directories = this.videoTempDirs.get(runId);
        this.videoTempDirs.delete(runId);
        this.downloadedVideoPaths.delete(runId);
        this.mediaAttachmentRefs.delete(runId);
        this.memoryDeliveries.delete(runId);
        if (directories) await Promise.all([...directories].map(directory => rm(directory, { recursive: true, force: true }).catch(error => log.warn("failed to clean downloaded video", { directory, error: String(error) }))));
        if (this.mediaRunControllers.get(runId) === mediaController && this.activeRunIds.get(sessionId) === runId) {
          this.runs.delete(runId);
          this.runModes.delete(sessionId);
          this.pendingApprovalIds.delete(sessionId);
          try {
            if (!session || opts.mcpServerId || ((this.restoreMessages || this.staleSessions.has(sessionId)) && session.isIdle)) await this.disposeSession(sessionId);
          } finally {
            if (this.mediaRunControllers.get(runId) === mediaController && this.activeRunIds.get(sessionId) === runId) {
              this.activeRunIds.delete(sessionId);
            }
          }
        }
        if (this.mediaRunControllers.get(runId) === mediaController) {
          this.mediaRunControllers.delete(runId);
          this.stoppedRuns.delete(runId);
        }
      }
    }
  }

  private generationContext(): GenerationContext {
    return {
      apiKeyFor: (provider) => this.modelApiKeys.get(provider),
      push: (type, payload, sessionId, runId) => this.push(type, payload, sessionId, runId),
      onGeneratedMedia: this.hooks.onGeneratedMedia,
      trackController: (runId, controller) => this.generationRunControllers.set(runId, controller),
      releaseController: (runId, controller) => { if (this.generationRunControllers.get(runId) === controller) this.generationRunControllers.delete(runId); },
    };
  }

  private runImageGeneration(sessionId: string, runId: string, prompt: string, attachments: MessageAttachmentInfo[] | undefined, config: ModelConfigInfo) {
    return runImageGeneration(this.generationContext(), sessionId, runId, prompt, attachments, config);
  }

  private runSpeechGeneration(sessionId: string, runId: string, text: string, config: ModelConfigInfo) {
    return runSpeechGeneration(this.generationContext(), sessionId, runId, text, config);
  }

  private runVideoGeneration(sessionId: string, runId: string, prompt: string, config: ModelConfigInfo) {
    return runVideoGeneration(this.generationContext(), sessionId, runId, prompt, config);
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
    if (session) void session.abort().catch(error => log.warn("session abort failed", { runId, error: String(error) }));
    log.info("run aborted", { runId });
    return true;
  }

  /** Detach non-cooperating work; only its own resources may be cleaned up later. */
  forceStop(runId: string): boolean {
    if (!this.stop(runId)) return false;
    const session = this.runs.get(runId);
    if (session) this.sessionFinalizers.get(session)?.(runId);
    const sessionId = [...this.activeRunIds].find(([, id]) => id === runId)?.[0];
    if (sessionId) {
      this.activeRunIds.delete(sessionId);
      this.sessionInputs.clear(sessionId);
      this.runModes.delete(sessionId);
      for (const id of this.pendingApprovalIds.get(sessionId) ?? []) this.approvals.reject(id);
      this.pendingApprovalIds.delete(sessionId);
      void this.disposeSession(sessionId).catch((error) => log.warn("forced session disposal failed", { runId, error: String(error) }));
    }
    this.runs.delete(runId);
    this.stoppedRuns.delete(runId);
    this.forceRejects.get(runId)?.(new Error("run aborted"));
    log.info("run force-stopped", { runId });
    return true;
  }

  hasSession(sessionId: string): boolean { return this.sessions.has(sessionId); }

  async waitForRun(runId: string, timeoutMs = 10_000): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while ([...this.activeRunIds.values()].includes(runId) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return ![...this.activeRunIds.values()].includes(runId);
  }

  /** Queue a child update at the next turn without aborting generation or tools. */
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
    const owner = expectedRunId ? this.forceRejects.get(expectedRunId) : undefined;
    return this.sessionInputs.run(sessionId, async () => {
      const session = this.activeRunIds.has(sessionId) ? this.sessions.get(sessionId) : undefined;
      const isCurrentRun = () => Boolean(expectedRunId && this.activeRunIds.get(sessionId) === expectedRunId && this.forceRejects.get(expectedRunId) === owner
        && this.sessions.get(sessionId) === session && !this.stoppedRuns.has(expectedRunId) && session?.isStreaming);
      if (!session || !isCurrentRun()) return false;
      const selectedModel = session.agent.state.model;
      const isGoogle = isGoogleGeminiApi(selectedModel?.api);
      const isCompletions = selectedModel?.api === "openai-completions";
      const input = selectedModel ? configuredCapabilities(this.configuredModelConfigs, `${selectedModel.provider}/${selectedModel.id}`).input : undefined;
      const runId = this.activeRunIds.get(sessionId);
      const videoAttachmentNotice = runId ? this.rememberVideoAttachments(runId, attachments) : "";
      const modelAttachments = await materializeModelInputs(attachments, isGoogle, input);
      const prompt = [videoAttachmentNotice, promptWithAttachments(message, attachments, Boolean(input?.includes("video") || input?.includes("audio")), input)].filter(Boolean).join("\n");
      const images = isGoogle ? googleMediaContent(modelAttachments, input)
        : [...imageContent(modelAttachments, input), ...(isCompletions ? googleMediaContent(modelAttachments?.filter((item) => item.mimeType.startsWith("audio/")), input) : [])];
      // Reject file preparation that outlived its target run, including a replacement run.
      if (!isCurrentRun()) return false;
      if (mode === "steer") await session.steer(prompt, images);
      else await session.followUp(prompt, images);
      if (!isCurrentRun()) {
        // Clear orphaned input only while this still owns the session.
        const activeRun = this.activeRunIds.get(sessionId);
        if ((!activeRun || activeRun === expectedRunId) && (!activeRun || this.forceRejects.get(activeRun) === owner) && this.sessions.get(sessionId) === session) session.clearQueue();
        return false;
      }
      return true;
    });
  }

  clearSessionQueue(sessionId: string): void { this.sessions.get(sessionId)?.clearQueue(); }
}
