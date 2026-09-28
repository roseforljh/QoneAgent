import {
  createAgentSession,
  createReadTool,
  createPowerShellTool,
  createEditTool,
  createWriteTool,
  createGrepTool,
  createFindTool,
  createLsTool,
  SessionManager,
  SettingsManager,
  estimateTokens,
  type AgentSession,
  type FileEntry,
  type ToolDefinition,
  type ResourceLoader,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { CAPABILITY_IDS, detectImageModel, modelListUrl, normalizeThinkingLevelForApi, type AgentEvent, type CapabilityId, type ImageApiFormat, type MessageAttachmentInfo, type ModelConfigInfo, type ModelMetadata, type ProviderApiType, type RunPermissionMode, type RunThinkingLevel } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { ApprovalQueue, withPermission, type PermissionRuleStore } from "./permissions.js";
import { createResourceLoader } from "./skills.js";
import { generateImage } from "./image-generation.js";
import { subagentResultForModel, subagentWorkflowResultForModel } from "./subagent-result.js";
import { googleMediaContent, googleStreamSimple, localMediaMarker } from "./google-media.js";
import { ModelMetadataResolver, providerBaseUrl } from "./model-resolver.js";

const log = createLogger("pi-adapter");
const MODEL_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;
const MIN_COMPACTION_THRESHOLD = 50;
const MAX_COMPACTION_THRESHOLD = 95;

export interface PiCompactionPreferences {
  autoCompactionEnabled: boolean;
  compactionThreshold: number;
}

export const DEFAULT_PI_COMPACTION_PREFERENCES: PiCompactionPreferences = {
  autoCompactionEnabled: true,
  compactionThreshold: 80,
};

export function normalizePiCompactionPreferences(value: unknown): PiCompactionPreferences {
  const record = value && typeof value === "object" ? value as Record<string, unknown> : {};
  const threshold = typeof record.compactionThreshold === "number" && Number.isInteger(record.compactionThreshold)
    ? Math.min(MAX_COMPACTION_THRESHOLD, Math.max(MIN_COMPACTION_THRESHOLD, record.compactionThreshold))
    : DEFAULT_PI_COMPACTION_PREFERENCES.compactionThreshold;
  return {
    autoCompactionEnabled: typeof record.autoCompactionEnabled === "boolean"
      ? record.autoCompactionEnabled
      : DEFAULT_PI_COMPACTION_PREFERENCES.autoCompactionEnabled,
    compactionThreshold: threshold,
  };
}

export function compactionReserveTokens(contextWindow: number, threshold: number): number {
  return Math.max(1, Math.ceil(contextWindow * (1 - threshold / 100)));
}

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
type DelegateSubagent = (input: { parentSessionId: string; parentRunId: string; parentSubagentId?: string; depth?: number; toolCallId: string; task: string; title: string; subagentId?: string; capability?: CapabilityId; fallbackModel?: string; permissionMode: RunPermissionMode; background?: boolean; signal?: AbortSignal }) => Promise<string>;
type WorkflowStep = { id: string; title: string; task: string; subagentId?: string; dependsOn?: string[] };
type SubagentController = import("./subagent-runner.js").SubagentController;

export interface GoalRuntimeBridge {
  get(sessionId: string, goalId: string, epoch: number, runId: string): unknown;
  complete(sessionId: string, goalId: string, epoch: number, runId: string, summary: string): unknown;
  blocked(sessionId: string, goalId: string, epoch: number, runId: string, reason: string, evidence: string): unknown;
  wait(sessionId: string, goalId: string, epoch: number, runId: string, reason: string, resumeAfterMs?: number): unknown;
}

export interface PersistedPiMessage {
  role: string;
  content: string;
  attachments?: MessageAttachmentInfo[];
  createdAt: number;
  rawMessage?: unknown;
}

function isPiTranscriptMessage(value: unknown): value is { role: string; [key: string]: unknown } {
  if (!value || typeof value !== "object") return false;
  const role = (value as { role?: unknown }).role;
  return typeof role === "string" && [
    "user", "assistant", "toolResult", "bashExecution", "custom",
    "branchSummary", "compactionSummary",
  ].includes(role);
}

export function imageContent(attachments: readonly MessageAttachmentInfo[] = []): ImageContent[] {
  return attachments.flatMap((attachment) => {
    if (attachment.type !== "image") return [];
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data);
    return match ? [{ type: "image" as const, data: match[2]!, mimeType: match[1]!.toLowerCase() }] : [];
  });
}

export function promptWithAttachments(message: string, attachments: readonly MessageAttachmentInfo[] = [], nativeMedia = false): string {
  const escapeName = (name: string) => name.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const files = attachments.flatMap((attachment) => {
    if (attachment.type !== "file") return [];
    if (nativeMedia && attachment.localPath) return [localMediaMarker(attachment.localPath, attachment.mimeType)];
    if (/^(?:audio|video)\//i.test(attachment.mimeType)) return nativeMedia
      ? []
      : [`[媒体附件 ${escapeName(attachment.name)}（${escapeName(attachment.mimeType)}）：当前模型无法直接读取，需要交给能处理该媒体的子代理]`];
    const match = /^data:[^,]*;base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data);
    if (!match) return [];
    const body = Buffer.from(match[1]!, "base64").toString("utf8");
    return [`<attachment name="${escapeName(attachment.name)}">\n${body}\n</attachment>`];
  });
  return [message.trim(), ...files].filter(Boolean).join("\n\n") || "请分析附件图片。";
}

/**
 * Rebuild the Pi transcript from the product database. Pi's own session files
 * are deliberately not the product source of truth, so a runtime restart must
 * recreate the in-memory SessionManager from the SQLite messages.
 */
export function createPiSessionEntries(
  cwd: string,
  messages: PersistedPiMessage[],
  model?: { api: string; provider: string; id: string },
): FileEntry[] {
  const header: FileEntry = {
    type: "session",
    version: 3,
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    cwd,
  };
  let parentId: string | null = null;
  const entries: FileEntry[] = [header];
  for (const message of messages) {
    if (isPiTranscriptMessage(message.rawMessage)) {
      const id = crypto.randomUUID();
      entries.push({ type: "message", id, parentId, timestamp: new Date(message.createdAt).toISOString(), message: message.rawMessage } as FileEntry);
      parentId = id;
      continue;
    }
    if (message.role !== "user" && message.role !== "assistant") continue;
    // Assistant messages require provider metadata in Pi's transcript format.
    // When no model is configured yet, keep the user side of the conversation;
    // the first configured run will establish the assistant model metadata.
    if (message.role === "assistant" && !model) continue;
    const id = crypto.randomUUID();
    const base = { type: "message" as const, id, parentId, timestamp: new Date(message.createdAt).toISOString() };
    const isGoogle = model?.api === "google-generative-ai";
    const images = isGoogle ? googleMediaContent(message.attachments) : imageContent(message.attachments);
    const prompt = promptWithAttachments(message.content, message.attachments, isGoogle);
    const value = message.role === "user"
      ? { ...base, message: { role: "user" as const, content: images.length ? [
          { type: "text" as const, text: prompt },
          ...images,
        ] : prompt, timestamp: message.createdAt } }
      : {
          ...base,
          message: {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: message.content }],
            api: model!.api,
            provider: model!.provider,
            model: model!.id,
            usage: {
              input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop" as const,
            timestamp: message.createdAt,
          },
        };
    entries.push(value as FileEntry);
    parentId = id;
  }
  return entries;
}

function splitModelName(name: string): [string, string] {
  const slash = name.indexOf("/");
  const colon = name.indexOf(":");
  const cut = slash < 0 ? colon : colon < 0 ? slash : Math.min(slash, colon);
  return cut < 0 ? [name, ""] : [name.slice(0, cut), name.slice(cut + 1)];
}

function extractTextContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  const record = value as { content?: unknown; message?: unknown; text?: unknown };
  if (typeof record.text === "string") return record.text;
  if (record.message && record.message !== value) return extractTextContent(record.message);
  if (!Array.isArray(record.content)) return "";
  return record.content.map((part) => {
    if (typeof part === "string") return part;
    if (!part || typeof part !== "object") return "";
    const text = (part as { text?: unknown }).text;
    return typeof text === "string" ? text : "";
  }).join("");
}

interface PiAdapterHooks {
  onMessage?: (sessionId: string, runId: string, role: "assistant" | "tool", content: string) => void;
  onAssistantFinal?: (sessionId: string, runId: string, content: string) => void;
  onTool?: (sessionId: string, runId: string, phase: "start" | "end", name: string, args?: unknown, result?: unknown, toolCallId?: string) => void;
}

// Wraps pi-coding-agent sessions and re-emits their events as our
// internal AgentEvent protocol so the GUI never imports Pi types.
// Coding tools (read/grep/find/ls/edit/write/powershell) come built in
// via createAgentSession — no custom search service needed for V1.
// MCP tools are injected through customTools. Skills are loaded through Pi's
// ResourceLoader rather than exposed as model-callable tools.
export class PiAdapter {
  private emit: EmitFn;
  private sessions = new Map<string, AgentSession>();
  private runs = new Map<string, AgentSession>();
  private activeRunIds = new Map<string, string>();
  private runModes = new Map<string, RunPermissionMode>();
  private stoppedRuns = new Set<string>();
  private seq = 0;
  private customTools: ToolDefinition[] = [];
  private staleSessions = new Set<string>();
  private approvals = new ApprovalQueue();
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
  private imageModelConfigs = new Map<string, ModelConfigInfo>();
  private imageRunControllers = new Map<string, AbortController>();
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

  async configureModels(configs: ModelConfigInfo[]): Promise<void> {
    // Commands and credential restoration arrive concurrently over NDJSON.
    // Serialize registry replacement so an older, slower /models request
    // cannot overwrite a newer model configuration.
    const snapshot = configs.map((item) => ({ ...item, config: { ...item.config } }));
    const operation = this.modelConfigurationQueue.then(() => this.applyModelConfiguration(snapshot));
    this.modelConfigurationQueue = operation.catch(() => undefined);
    return operation;
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
        }
      }
      const firstResolved = resolved[0];
      this.modelRuntime.registerProvider(provider, {
        name: provider,
        baseUrl: firstResolved.baseUrl,
        api: firstResolved.api as never,
        ...(firstResolved.api === "google-generative-ai" ? { streamSimple: googleStreamSimple as never } : {}),
        models: models.map((item, index) => {
          const model = resolved[index];
          return {
            id: item.model,
            name: model.name,
            api: model.api as never,
            baseUrl: model.baseUrl,
            reasoning: model.reasoning,
            input: model.input,
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
  }

  private thinkingLevelForModel(modelName: string): ThinkingLevel | undefined {
    const direct = this.thinkingLevels.get(modelName);
    if (direct) return direct;
    const [provider, model] = splitModelName(modelName);
    return this.thinkingLevels.get(`${provider}/${model}`) ?? this.thinkingLevels.get(`${provider}:${model}`);
  }

  async disposeSession(sessionId: string): Promise<void> {
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
      await this.configureModels(this.configuredModelConfigs).catch((error) => {
        log.warn("model metadata refresh failed", { provider, err: String(error) });
      });
    }
  }

  isRunning(sessionId: string): boolean {
    return this.compactingSessions.has(sessionId) || this.executionSessionFor(sessionId) !== undefined;
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
    const reported = session.getContextUsage()?.tokens;
    return {
      tokens: reported ?? session.messages.reduce((total, message) => total + estimateTokens(message), 0),
      contextWindow: model.contextWindow,
    };
  }

  private executionSessionFor(sessionId: string): string | undefined {
    if (this.activeRunIds.has(sessionId)) return sessionId;
    return [...this.activeRunIds.keys()].find((id) => id.startsWith(`${sessionId}::subagent::`));
  }

  async deleteSecret(key: string): Promise<void> {
    const provider = key.startsWith("model.apiKey:") ? key.slice("model.apiKey:".length) : key;
    if (key.startsWith("model.apiKey:")) this.modelApiKeys.delete(provider);
    this.modelMetadataResolver.invalidateProviderCatalog(provider);
    if (this.modelRuntime) await this.modelRuntime.removeRuntimeApiKey(provider);
    if (key.startsWith("model.apiKey:") && this.configuredModelConfigs.length > 0) {
      await this.configureModels(this.configuredModelConfigs).catch((error) => {
        log.warn("model metadata refresh after credential removal failed", { provider, err: String(error) });
      });
    }
  }

  async generateTitle(prompt: string, modelName?: string): Promise<string> {
    this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
    const model = modelName
      ? this.modelRuntime.getModel(...splitModelName(modelName))
      : this.modelRuntime.getModels()[0];
    if (!model) throw new Error("no configured model available for title generation");
    const response = await this.modelRuntime.completeSimple(model, {
      systemPrompt: "Generate a concise conversation title from the user's first message. Output only the title, with no quotes, punctuation, explanation, or markdown. Keep it under 8 words when writing in English and under 20 Chinese characters when writing in Chinese.",
      messages: [{ role: "user", content: prompt, timestamp: Date.now() }],
    }, { maxTokens: 32, temperature: 0.2 });
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

  private async getSession(sessionId: string, cwd?: string, modelName?: string, thinkingOverride?: RunThinkingLevel, eventSessionId = sessionId, mcpServerId?: string, subagentDepth = 0, subagentRunId?: string, toolAllowList?: string[], goalId?: string, goalEpoch?: number, goalRunId?: string): Promise<AgentSession> {
    const modelKey = modelName ? splitModelName(modelName).join("/") : undefined;
    const apiType = modelKey ? this.modelApiTypes.get(modelKey) : undefined;
    const override = thinkingOverride ? normalizeThinkingLevelForApi(thinkingOverride, apiType) : undefined;
    const thinking = override ? (override === "none" ? "off" : override) : modelName ? this.thinkingLevelForModel(modelName) : undefined;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (this.staleSessions.has(sessionId) && existing.isIdle) {
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
        await existing.setModel(nextModel);
         if (thinking) existing.setThinkingLevel(thinking);
      }
      return existing;
      }
    }

    const workspacePath = cwd ?? process.cwd();
    if (!this.resourceLoaders.has(workspacePath)) {
      const { loader } = await createResourceLoader(workspacePath);
      this.resourceLoaders.set(workspacePath, loader);
    }
    const builtinTools = [
      createReadTool(workspacePath),
      createPowerShellTool(workspacePath),
      createEditTool(workspacePath),
      createWriteTool(workspacePath),
      createGrepTool(workspacePath),
      createFindTool(workspacePath),
      createLsTool(workspacePath),
    ];
    const customTools = mcpServerId
      ? this.customTools.filter((tool) => (tool as ToolDefinition & { qoneToolName?: string }).qoneToolName?.startsWith(`mcp:${mcpServerId}:`))
      : this.customTools;
    const policy = this.subagentPolicy?.();
    const canDelegate = this.delegateSubagent && (!subagentRunId || (policy?.allowNested ?? true)) && subagentDepth < (policy?.maxDepth ?? 3);
    const checkChild = (id: string) => {
      const target = this.subagentController!.query(id);
      const owner = subagentRunId ? this.subagentController!.query(subagentRunId) : undefined;
      if (!target || target.parentSessionId !== (owner?.parentSessionId ?? eventSessionId)) throw new Error("Subagent is outside this conversation");
      if (subagentRunId) {
        let ancestor = target.parentSubagentId;
        while (ancestor && ancestor !== subagentRunId) ancestor = this.subagentController!.query(ancestor)?.parentSubagentId;
        if (ancestor !== subagentRunId) throw new Error("Only descendant subagents can be inspected or controlled");
      }
    };
    const inspectTools: ToolDefinition[] = this.subagentController ? [{
      name: "inspect_subagent",
      label: "Inspect subagent",
      description: "Read a subagent's status, text result, generated images, streaming output and child IDs by run ID. The full transcript remains in the side panel.",
      promptSnippet: "Use inspect_subagent when you need to check a delegated task before it finishes.",
      parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }) }),
      execute: async (_toolCallId, params) => {
        const runId = (params as { runId: string }).runId;
        checkChild(runId);
        const result = this.subagentController!.query(runId);
        if (!result) throw new Error(`Unknown subagent ${runId}`);
        return subagentResultForModel(result);
      },
    }, {
      name: "run_subagent_workflow",
      label: "Run subagent workflow",
      description: "Run dependent or independent subagent steps. Independent steps run in parallel; dependent steps wait for their prerequisites.",
      promptSnippet: "Use run_subagent_workflow for multi-step delegation such as scout → implement → review.",
      parameters: Type.Object({
        steps: Type.Array(Type.Object({
          id: Type.String({ minLength: 1, maxLength: 64 }),
          title: Type.String({ minLength: 1, maxLength: 120 }),
          task: Type.String({ minLength: 1, maxLength: 32_000 }),
          subagentId: Type.Optional(Type.String({ maxLength: 128 })),
          dependsOn: Type.Optional(Type.Array(Type.String({ maxLength: 64 }), { maxItems: 32 })),
        }), { minItems: 1, maxItems: 128 }),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        const input = params as { steps: WorkflowStep[] };
        const parentRunId = this.activeRunIds.get(sessionId);
        if (!parentRunId) throw new Error("No active parent run");
        const result = await this.subagentController!.workflow(eventSessionId, parentRunId, input.steps, {
          model: modelName, permissionMode: this.runModes.get(sessionId) ?? "ask", signal,
        });
        return subagentWorkflowResultForModel(result);
      },
    }, {
      name: "wait_subagent",
      label: "Wait for subagent",
      description: "Wait for a subagent to finish and return its current result.",
      promptSnippet: "Use wait_subagent after starting a background subagent when you need its final result.",
      parameters: Type.Object({ runId: Type.String({ minLength: 1, maxLength: 128 }), timeoutMs: Type.Optional(Type.Number({ minimum: 1000, maximum: 86_400_000 })) }),
      executionMode: "sequential",
      execute: async (_toolCallId, params, signal) => {
        const input = params as { runId: string; timeoutMs?: number };
        checkChild(input.runId);
        const result = await this.subagentController!.wait(input.runId, input.timeoutMs, signal, subagentRunId);
        return subagentResultForModel(result);
      },
    }, {
      name: "control_subagent",
      label: "Control subagent",
      description: "Stop, resume, retry, steer or send a follow-up to an existing subagent session.",
      promptSnippet: "Use control_subagent to continue, correct, retry or stop a delegated task.",
      parameters: Type.Object({
        runId: Type.String({ minLength: 1, maxLength: 128 }),
        action: Type.Union([Type.Literal("stop"), Type.Literal("resume"), Type.Literal("retry"), Type.Literal("steer"), Type.Literal("follow_up")]),
        message: Type.Optional(Type.String({ maxLength: 32_000 })),
      }),
      executionMode: "sequential",
      execute: async (_toolCallId, params) => {
        const input = params as { runId: string; action: "stop" | "resume" | "retry" | "steer" | "follow_up"; message?: string };
        checkChild(input.runId);
        const result = await this.subagentController!.control(input.runId, input.action, input.message);
        return subagentResultForModel(result);
      },
    }] : [];
    const delegateTool: ToolDefinition[] = canDelegate ? [{
      name: "list_subagents",
      label: "List subagents",
      description: "List the subagents the user has configured: capability subagents (image generation, speech-to-text, text-to-speech, video recognition, web search) and saved subagent profiles. Call this when the task needs an ability you do not have yourself, before telling the user you cannot do it.",
      promptSnippet: "If a task needs something you cannot do yourself (for example producing an image or audio, or reading audio/video you cannot perceive), call list_subagents, then dispatch_subagent with the matching capability or subagentId. If nothing suitable is configured, tell the user plainly that it cannot be done and which setting is missing; never pretend to have done it.",
      parameters: Type.Object({}),
      execute: async () => {
        const result = this.subagentController!.catalog();
        return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
      },
    }, {
      name: "dispatch_subagent",
      label: "Delegate to subagent",
      description: `Run one independent task with a subagent. Set capability to hand the task to the subagent the user configured for that capability (the user's current attachments are forwarded to it); set subagentId to use a saved profile; set neither for a temporary subagent whose model is configured in Settings > Subagents > Temporary agent. When the user asks for N tasks or asks to start another subagent, call this tool once for each task, including in a later turn; do not stop at three. Multiple calls in one turn execute in parallel. The configured maximum of ${policy?.maxConcurrent ?? "the current"} is a simultaneous running limit, not a total task limit: completed tasks release capacity and extra tasks wait in the FIFO queue. Returns the subagent's final result, or its status and error when it fails; the runtime never retries on its own, so read the error and decide yourself whether a retry via control_subagent makes sense. The full transcript is available in the side panel.`,
      promptSnippet: "Use dispatch_subagent once per requested task. Unless a capability or saved subagent profile is selected, the temporary agent uses the model configured in Settings > Subagents > Temporary agent. If the user asks to start another subagent after earlier tasks, dispatch it too. Do not assume a total limit of three; maxConcurrent limits simultaneous execution only, and overflow is queued.",
      parameters: Type.Object({
        title: Type.String({ minLength: 1, maxLength: 120 }),
        task: Type.String({ minLength: 1, maxLength: 32_000 }),
        capability: Type.Optional(Type.Union(CAPABILITY_IDS.map((id) => Type.Literal(id)))),
        subagentId: Type.Optional(Type.String({ maxLength: 128 })),
        background: Type.Optional(Type.Boolean()),
      }),
      executionMode: "parallel",
      execute: async (toolCallId, params, signal) => {
        const input = params as { title: string; task: string; capability?: CapabilityId; subagentId?: string; background?: boolean };
        const parentRunId = this.activeRunIds.get(sessionId);
        if (!parentRunId || !this.delegateSubagent) throw new Error("No active parent run");
        const result = await this.delegateSubagent({
          parentSessionId: eventSessionId, parentRunId, parentSubagentId: subagentRunId, depth: subagentDepth + 1, toolCallId,
          title: input.title.trim(), task: input.task.trim(), subagentId: input.subagentId, capability: input.capability,
          fallbackModel: modelName, permissionMode: this.runModes.get(sessionId) ?? "ask", background: input.background, signal,
        });
        const completed = (() => {
          try { return JSON.parse(result) as { runId?: string }; } catch { return undefined; }
        })();
        const info = completed?.runId ? this.subagentController?.query(completed.runId) : undefined;
        return info ? subagentResultForModel(info) : { content: [{ type: "text", text: result }], details: {} };
      },
    }] : [];
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
    const goalToolNames = new Set(goalTools.map((tool) => tool.name));
    const wrapped = [...builtinTools, ...customTools, ...inspectTools, ...delegateTool, ...goalTools].map((t) =>
      withPermission(t, {
        queue: this.approvals,
        workspacePath,
        rules: this.permissionRules,
        mode: () => this.runModes.get(sessionId) ?? "ask",
        internal: goalToolNames.has(t.name),
        emitApproval: (approvalId, toolName, args, toolCallId) =>
          this.push("approval.requested", { approvalId, toolName, args, toolCallId }, eventSessionId, this.activeRunIds.get(sessionId)),
      })
    );
    const allowed = toolAllowList
      ? wrapped.filter((tool) => goalToolNames.has(tool.name) || toolAllowList.includes(tool.name) || toolAllowList.includes((tool as ToolDefinition & { qoneToolName?: string }).qoneToolName ?? ""))
      : wrapped;
    assertModelToolNames(allowed.map((tool) => tool.name));

    const toolNameByModelName = new Map(wrapped.map((tool) => [
      tool.name,
      (tool as ToolDefinition & { qoneToolName?: string }).qoneToolName ?? tool.name,
    ]));

    const resourceLoader = this.resourceLoaders.get(workspacePath);
    let modelRuntime: ModelRuntime | undefined;
    let model;
    if (modelName) {
      this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
      modelRuntime = this.modelRuntime;
      const [provider, modelId] = splitModelName(modelName);
      model = modelRuntime.getModel(provider, modelId);
      if (!model) throw new Error(`configured model not found: ${modelName}`);
    }
    const sessionManager = SessionManager.inMemory(
      workspacePath,
      undefined,
      createPiSessionEntries(workspacePath, this.restoreMessages?.(sessionId, this.activeRunIds.get(sessionId)) ?? [], model),
    );
    const sessionSettings = SettingsManager.inMemory();
    sessionSettings.applyOverrides(this.compactionOverrides());
    const { session } = await createAgentSession({
      cwd: workspacePath,
      sessionManager,
      // Built-ins are supplied as wrapped definitions so every tool goes through
      // the same permission boundary. Bash is intentionally omitted on Windows.
      tools: allowed.map((tool) => tool.name),
      customTools: allowed,
      resourceLoader,
      modelRuntime,
      settingsManager: sessionSettings,
      model,
      thinkingLevel: thinking,
    });
    try {
      assertModelToolNames(session.getActiveToolNames());
    } catch (error) {
      await session.dispose();
      throw error;
    }

    let lastToolDeltaAt = 0;
    session.subscribe((e) => {
      const runId = [...this.runs.entries()].find(([, s]) => s === session)?.[0];
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
        if (messageEvent?.type === "text_delta") {
          protocolType = "message.delta";
          protocolPayload = { delta: messageEvent.delta ?? "", contentIndex: messageEvent.contentIndex };
        } else if (messageEvent?.type === "text_start" || messageEvent?.type === "toolcall_start") {
          protocolType = "message.block.started";
          protocolPayload = messageEvent.type === "text_start"
            ? { blockType: "text", contentIndex: messageEvent.contentIndex }
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
      else if (e.type === "tool_execution_start") {
        protocolType = "tool.started";
        protocolPayload = { toolCallId: raw.toolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, args: raw.args ?? raw.input };
      } else if (e.type === "tool_execution_update") {
        protocolType = "tool.updated";
        protocolPayload = { toolCallId: raw.toolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, update: raw.partialResult ?? raw.update };
      } else if (e.type === "tool_execution_end") {
        const result = raw.result as { isError?: boolean } | undefined;
        protocolType = result?.isError ? "tool.failed" : "tool.completed";
        protocolPayload = { toolCallId: raw.toolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, result: raw.result, isError: result?.isError ?? false };
      } else if (e.type === "agent_start") protocolType = "turn.started";
      else if (e.type === "agent_end") protocolType = "turn.completed";
      this.push(protocolType, protocolPayload, eventSessionId, runId);
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
        this.hooks.onTool?.(eventSessionId, runId, "start", name, toolPayload.args, undefined, toolPayload.toolCallId);
      }
      if (e.type === "tool_execution_end") {
        const name = toolNameByModelName.get(String(toolPayload.toolName ?? "")) ?? String(toolPayload.toolName ?? "tool");
        this.hooks.onTool?.(eventSessionId, runId, "end", name, toolPayload.args, toolPayload.result, toolPayload.toolCallId);
      }
    });

    this.sessions.set(sessionId, session);
    this.sessionSettingsManagers.set(sessionId, sessionSettings);
    return session;
  }

  approve(approvalId: string): boolean {
    return this.approvals.approve(approvalId);
  }

  reject(approvalId: string): boolean {
    return this.approvals.reject(approvalId);
  }

  async run(
    sessionId: string,
    message: string,
    opts: { model?: string; cwd?: string; runId?: string; permissionMode?: RunPermissionMode; thinking?: RunThinkingLevel; attachments?: MessageAttachmentInfo[]; eventSessionId?: string; mcpServerId?: string; subagentDepth?: number; subagentRunId?: string; toolAllowList?: string[]; goalId?: string; goalEpoch?: number },
    runEmit: RunEmitFn
  ): Promise<void> {
    if (this.activeRunIds.has(sessionId) || this.compactingSessions.has(sessionId)) throw new Error(`session ${sessionId} already has an active run or compaction`);
    const runId = opts.runId ?? crypto.randomUUID();
    this.activeRunIds.set(sessionId, runId);
    this.runModes.set(sessionId, opts.permissionMode ?? "ask");
    const configuredImageModel = opts.model ? this.imageModelConfigs.get(opts.model) : undefined;
    let session: AgentSession | undefined;
    try {
      if (configuredImageModel) {
        await this.runImageGeneration(sessionId, runId, message, opts.attachments, configuredImageModel);
        runEmit("agent.prompt_done", { runId });
        return;
      }
      session = await this.getSession(sessionId, opts.cwd, opts.model, opts.thinking, opts.eventSessionId ?? sessionId, opts.mcpServerId, opts.subagentDepth, opts.subagentRunId, opts.toolAllowList, opts.goalId, opts.goalEpoch, runId);
      if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
      this.runs.set(runId, session);
      const previousLength = session.messages.length;
      const selectedModel = opts.model
        ? this.modelRuntime?.getModel(...splitModelName(opts.model))
        : session.agent.state.model;
      const isGoogle = selectedModel?.api === "google-generative-ai";
      await session.prompt(promptWithAttachments(message, opts.attachments, isGoogle), {
        images: isGoogle ? googleMediaContent(opts.attachments) : imageContent(opts.attachments),
      });
      const assistantMessages = session.messages.slice(previousLength).filter((item) => item.role === "assistant");
      const final = assistantMessages.at(-1);
      if (!final) throw new Error("Model returned no assistant response");
      if (final.stopReason === "error") throw new Error(final.errorMessage || "Model request failed");
      if (final.stopReason === "aborted" && !this.stoppedRuns.has(runId)) throw new Error(final.errorMessage || "Model request aborted");
      if (!assistantMessages.some((item) => extractTextContent(item).trim())) {
        throw new Error("AI returned an empty response");
      }
      runEmit("agent.prompt_done", { runId });
    } catch (error) {
      // Pi cannot resume this in-memory transcript after its compaction continuation
      // lands on an assistant message. Rebuild from persisted messages on the next run.
      if (String(error).includes("Cannot continue from message role: assistant")) this.staleSessions.add(sessionId);
      throw error;
    } finally {
      this.runs.delete(runId);
      this.runModes.delete(sessionId);
      this.stoppedRuns.delete(runId);
      if (this.activeRunIds.get(sessionId) === runId) this.activeRunIds.delete(sessionId);
      if (session && this.staleSessions.has(sessionId) && session.isIdle) {
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
    this.imageRunControllers.set(runId, controller);
    this.push("message.started", { message: { role: "assistant" } }, sessionId, runId);
    try {
      const parts = await generateImage({ config, format: detected.format, prompt, attachments, apiKey, signal: controller.signal });
      this.push("message.completed", { message: { role: "assistant", content: parts } }, sessionId, runId);
    } finally {
      this.imageRunControllers.delete(runId);
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
    this.imageRunControllers.get(runId)?.abort();
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

  async sendToSession(sessionId: string, message: string, mode: "steer" | "follow_up", attachments?: MessageAttachmentInfo[]): Promise<boolean> {
    const executionSessionId = this.executionSessionFor(sessionId);
    const session = executionSessionId ? this.sessions.get(executionSessionId) : undefined;
    if (!session || !session.isStreaming) return false;
    const selectedModel = session.agent.state.model;
    const isGoogle = selectedModel?.api === "google-generative-ai";
    const prompt = promptWithAttachments(message, attachments, isGoogle);
    const images = isGoogle ? googleMediaContent(attachments) : imageContent(attachments);
    if (mode === "steer") await session.steer(prompt, images);
    else await session.followUp(prompt, images);
    return true;
  }

  clearSessionQueue(sessionId: string): void {
    this.sessions.get(sessionId)?.clearQueue();
  }
}
