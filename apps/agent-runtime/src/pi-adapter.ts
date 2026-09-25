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
  type AgentSession,
  type FileEntry,
  type ToolDefinition,
  type ResourceLoader,
  ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
import type { ImageContent } from "@earendil-works/pi-ai";
import { modelListUrl, normalizeThinkingLevelForApi, type AgentEvent, type MessageAttachmentInfo, type ModelConfigInfo, type ProviderApiType, type RunPermissionMode, type RunThinkingLevel } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { ApprovalQueue, withPermission, type PermissionRuleStore } from "./permissions.js";
import { createResourceLoader } from "./skills.js";
import { ModelMetadataResolver, providerBaseUrl } from "./model-resolver.js";

const log = createLogger("pi-adapter");
const MODEL_TOOL_NAME = /^[a-zA-Z0-9_-]+$/;

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

export interface PersistedPiMessage {
  role: string;
  content: string;
  attachments?: MessageAttachmentInfo[];
  createdAt: number;
}

export function imageContent(attachments: readonly MessageAttachmentInfo[] = []): ImageContent[] {
  return attachments.flatMap((attachment) => {
    if (attachment.type !== "image") return [];
    const match = /^data:(image\/(?:png|jpeg|webp|gif));base64,([A-Za-z0-9+/=]+)$/i.exec(attachment.data);
    return match ? [{ type: "image" as const, data: match[2]!, mimeType: match[1]!.toLowerCase() }] : [];
  });
}

export function promptWithAttachments(message: string, attachments: readonly MessageAttachmentInfo[] = []): string {
  const escapeName = (name: string) => name.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
  const files = attachments.flatMap((attachment) => {
    if (attachment.type !== "file") return [];
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
    if (message.role !== "user" && message.role !== "assistant") continue;
    // Assistant messages require provider metadata in Pi's transcript format.
    // When no model is configured yet, keep the user side of the conversation;
    // the first configured run will establish the assistant model metadata.
    if (message.role === "assistant" && !model) continue;
    const id = crypto.randomUUID();
    const base = { type: "message" as const, id, parentId, timestamp: new Date(message.createdAt).toISOString() };
    const images = imageContent(message.attachments);
    const prompt = promptWithAttachments(message.content, message.attachments);
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
  private resourceLoaders = new Map<string, ResourceLoader>();
  private modelRuntime?: ModelRuntime;
  private thinkingLevels = new Map<string, ThinkingLevel>();
  private modelApiTypes = new Map<string, ProviderApiType>();
  private modelApiKeys = new Map<string, string>();
  private configuredModelConfigs: ModelConfigInfo[] = [];
  private modelConfigurationQueue: Promise<void> = Promise.resolve();
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
  ) {
    this.emit = emit;
    this.hooks = hooks;
  }

  // Called once at boot after MCP manager finishes loading.
  async setCustomTools(tools: ToolDefinition[]) {
    this.customTools = tools;
    for (const [sessionId, session] of this.sessions) {
      if (session.isIdle) {
        await session.dispose();
        this.sessions.delete(sessionId);
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

  async refreshSkills(): Promise<void> {
    this.resourceLoaders.clear();
    for (const [sessionId, session] of this.sessions) {
      if (session.isIdle) {
        await session.dispose();
        this.sessions.delete(sessionId);
      } else {
        this.staleSessions.add(sessionId);
      }
    }
  }

  private async applyModelConfiguration(configs: ModelConfigInfo[]): Promise<void> {
    this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
    this.configuredModelConfigs = configs;
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
      const firstResolved = resolved[0];
      this.modelRuntime.registerProvider(provider, {
        name: provider,
        baseUrl: firstResolved.baseUrl,
        api: firstResolved.api as never,
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
    return this.activeRunIds.has(sessionId);
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

  private async getSession(sessionId: string, cwd?: string, modelName?: string, thinkingOverride?: RunThinkingLevel): Promise<AgentSession> {
    const modelKey = modelName ? splitModelName(modelName).join("/") : undefined;
    const apiType = modelKey ? this.modelApiTypes.get(modelKey) : undefined;
    const override = thinkingOverride ? normalizeThinkingLevelForApi(thinkingOverride, apiType) : undefined;
    const thinking = override ? (override === "none" ? "off" : override) : modelName ? this.thinkingLevelForModel(modelName) : undefined;
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (this.staleSessions.has(sessionId) && existing.isIdle) {
        await existing.dispose();
        this.sessions.delete(sessionId);
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
    const wrapped = [...builtinTools, ...this.customTools].map((t) =>
      withPermission(t, {
        queue: this.approvals,
        workspacePath,
        rules: this.permissionRules,
        mode: () => this.runModes.get(sessionId) ?? "ask",
        emitApproval: (approvalId, toolName, args, toolCallId) =>
          this.push("approval.requested", { approvalId, toolName, args, toolCallId }, sessionId, this.activeRunIds.get(sessionId)),
      })
    );
    assertModelToolNames(wrapped.map((tool) => tool.name));

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
    const { session } = await createAgentSession({
      cwd: workspacePath,
      sessionManager,
      // Built-ins are supplied as wrapped definitions so every tool goes through
      // the same permission boundary. Bash is intentionally omitted on Windows.
      tools: wrapped.map((tool) => tool.name),
      customTools: wrapped,
      resourceLoader,
      modelRuntime,
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
      this.push(protocolType, protocolPayload, sessionId, runId);
      if (!runId) return;
      const p = normalized as { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; message?: unknown; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
      const toolPayload = protocolPayload as { toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
      const delta = p.assistantMessageEvent?.delta;
      if (p.assistantMessageEvent?.type === "text_delta" && typeof delta === "string" && delta) this.hooks.onMessage?.(sessionId, runId, "assistant", delta);
      if (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason !== "error" && e.message.stopReason !== "aborted") {
        const finalText = extractTextContent(raw.message);
        if (finalText) this.hooks.onAssistantFinal?.(sessionId, runId, finalText);
      }
      if (e.type === "tool_execution_start") {
        const name = toolNameByModelName.get(String(toolPayload.toolName ?? "")) ?? String(toolPayload.toolName ?? "tool");
        this.hooks.onTool?.(sessionId, runId, "start", name, toolPayload.args, undefined, toolPayload.toolCallId);
      }
      if (e.type === "tool_execution_end") {
        const name = toolNameByModelName.get(String(toolPayload.toolName ?? "")) ?? String(toolPayload.toolName ?? "tool");
        this.hooks.onTool?.(sessionId, runId, "end", name, toolPayload.args, toolPayload.result, toolPayload.toolCallId);
      }
    });

    this.sessions.set(sessionId, session);
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
    opts: { model?: string; cwd?: string; runId?: string; permissionMode?: RunPermissionMode; thinking?: RunThinkingLevel; attachments?: MessageAttachmentInfo[] },
    runEmit: RunEmitFn
  ): Promise<void> {
    if (this.activeRunIds.has(sessionId)) throw new Error(`session ${sessionId} already has an active run`);
    const runId = opts.runId ?? crypto.randomUUID();
    this.activeRunIds.set(sessionId, runId);
    this.runModes.set(sessionId, opts.permissionMode ?? "ask");
    let session: AgentSession | undefined;
    try {
      session = await this.getSession(sessionId, opts.cwd, opts.model, opts.thinking);
      if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
      this.runs.set(runId, session);
      const previousLength = session.messages.length;
      await session.prompt(promptWithAttachments(message, opts.attachments), { images: imageContent(opts.attachments) });
      const assistantMessages = session.messages.slice(previousLength).filter((item) => item.role === "assistant");
      const final = assistantMessages.at(-1);
      if (!final) throw new Error("Model returned no assistant response");
      if (final.stopReason === "error") throw new Error(final.errorMessage || "Model request failed");
      if (final.stopReason === "aborted" && !this.stoppedRuns.has(runId)) throw new Error(final.errorMessage || "Model request aborted");
      if (!assistantMessages.some((item) => extractTextContent(item).trim())) {
        throw new Error("AI returned an empty response");
      }
      runEmit("agent.prompt_done", { runId });
    } finally {
      this.runs.delete(runId);
      this.runModes.delete(sessionId);
      this.stoppedRuns.delete(runId);
      if (this.activeRunIds.get(sessionId) === runId) this.activeRunIds.delete(sessionId);
      if (session && this.staleSessions.has(sessionId) && session.isIdle) {
        await session.dispose();
        this.sessions.delete(sessionId);
        this.staleSessions.delete(sessionId);
      }
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
    if (session) void session.abort();
    log.info("run aborted", { runId });
    return true;
  }
}
