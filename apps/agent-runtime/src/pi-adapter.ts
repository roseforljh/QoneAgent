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
import type { AgentEvent } from "@qone/protocol";
import { createLogger } from "@qone/shared";
import { ApprovalQueue, withPermission, type PermissionRuleStore } from "./permissions.js";
import { createResourceLoader, type PluginSkillInput } from "./skills.js";

const log = createLogger("pi-adapter");

type EmitFn = (event: AgentEvent) => void;
type RunEmitFn = (type: string, payload: unknown) => void;

export interface PersistedPiMessage {
  role: string;
  content: string;
  createdAt: number;
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
    const value = message.role === "user"
      ? { ...base, message: { role: "user" as const, content: message.content, timestamp: message.createdAt } }
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

interface PiAdapterHooks {
  onMessage?: (sessionId: string, runId: string, role: "assistant" | "tool", content: string) => void;
  onTool?: (sessionId: string, runId: string, phase: "start" | "end", name: string, args?: unknown, result?: unknown, toolCallId?: string) => void;
}

// Wraps pi-coding-agent sessions and re-emits their events as our
// internal AgentEvent protocol so the GUI never imports Pi types.
// Coding tools (read/grep/find/ls/edit/write/powershell) come built in
// via createAgentSession — no custom search service needed for V1.
// Extra tools (MCP, plugin, browser) get injected via customTools.
export class PiAdapter {
  private emit: EmitFn;
  private sessions = new Map<string, AgentSession>();
  private runs = new Map<string, AgentSession>();
  private activeRunIds = new Map<string, string>();
  private stoppedRuns = new Set<string>();
  private seq = 0;
  private customTools: ToolDefinition[] = [];
  private staleSessions = new Set<string>();
  private approvals = new ApprovalQueue();
  private hooks: PiAdapterHooks;
  private resourceLoaders = new Map<string, ResourceLoader>();
  private modelRuntime?: ModelRuntime;
  private pluginSkills: PluginSkillInput[] = [];
  private sessionToolProvider?: (sessionId: string) => ToolDefinition[];
  private sessionToolDisposer?: (sessionId: string) => void | Promise<void>;

  constructor(
    emit: EmitFn,
    hooks: PiAdapterHooks = {},
    private permissionRules?: PermissionRuleStore,
    private restoreMessages?: (sessionId: string) => PersistedPiMessage[],
  ) {
    this.emit = emit;
    this.hooks = hooks;
  }

  // Called once at boot after MCP/plugin managers finish loading.
  setCustomTools(tools: ToolDefinition[]) {
    this.customTools = tools;
    for (const [sessionId, session] of this.sessions) {
      if (session.isIdle) {
        session.dispose();
        this.sessions.delete(sessionId);
        void this.sessionToolDisposer?.(sessionId);
      } else {
        // Do not interrupt an active run. It will be recreated after settling.
        this.staleSessions.add(sessionId);
      }
    }
  }

  setPluginSkills(skills: PluginSkillInput[]) {
    this.pluginSkills = skills;
    this.resourceLoaders.clear();
  }

  setSessionTools(
    provider: (sessionId: string) => ToolDefinition[],
    disposer: (sessionId: string) => void | Promise<void>,
  ) {
    this.sessionToolProvider = provider;
    this.sessionToolDisposer = disposer;
  }

  async disposeSession(sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (session) {
      await session.dispose();
      this.sessions.delete(sessionId);
    }
    this.staleSessions.delete(sessionId);
    await this.sessionToolDisposer?.(sessionId);
  }

  getSessions(): AgentSession[] {
    return [...this.sessions.values()];
  }

  /** Store credentials only in the live process and hand them to Pi's
   * provider runtime. The desktop persists the same value in Credential
   * Manager; it is never written to SQLite. */
  async setSecret(key: string, value: string): Promise<void> {
    const provider = key.startsWith("model.apiKey:") ? key.slice("model.apiKey:".length) : key;
    this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
    await this.modelRuntime.setRuntimeApiKey(provider, value);
  }

  async deleteSecret(key: string): Promise<void> {
    const provider = key.startsWith("model.apiKey:") ? key.slice("model.apiKey:".length) : key;
    if (!this.modelRuntime) return;
    await this.modelRuntime.removeRuntimeApiKey(provider);
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

  private async getSession(sessionId: string, cwd?: string, modelName?: string): Promise<AgentSession> {
    const existing = this.sessions.get(sessionId);
    if (existing) {
      if (this.staleSessions.has(sessionId) && existing.isIdle) {
        existing.dispose();
        this.sessions.delete(sessionId);
        this.staleSessions.delete(sessionId);
        await this.sessionToolDisposer?.(sessionId);
      } else {
      if (modelName) {
        this.modelRuntime ??= await ModelRuntime.create({ allowModelNetwork: false });
        const [provider, modelId] = splitModelName(modelName);
        const nextModel = this.modelRuntime.getModel(provider, modelId);
        if (!nextModel) throw new Error(`configured model not found: ${modelName}`);
        await existing.setModel(nextModel);
      }
      return existing;
      }
    }

    const workspacePath = cwd ?? process.cwd();
    if (!this.resourceLoaders.has(workspacePath)) {
      const { loader } = await createResourceLoader(workspacePath, this.pluginSkills);
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
    const sessionTools = this.sessionToolProvider?.(sessionId) ?? [];
    const wrapped = [...builtinTools, ...this.customTools, ...sessionTools].map((t) =>
      withPermission(t, {
        queue: this.approvals,
        workspacePath,
        rules: this.permissionRules,
        emitApproval: (approvalId, toolName, args, toolCallId) =>
          this.push("approval.requested", { approvalId, toolName, args, toolCallId }, sessionId, this.activeRunIds.get(sessionId)),
      })
    );

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
      createPiSessionEntries(workspacePath, this.restoreMessages?.(sessionId) ?? [], model),
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
    });

    session.subscribe((e) => {
      const runId = [...this.runs.entries()].find(([, s]) => s === session)?.[0];
      const raw = e as unknown as Record<string, unknown>;
      const messageEvent = raw.assistantMessageEvent as { delta?: string } | undefined;
      const normalized = messageEvent?.delta
        ? { ...raw, delta: messageEvent.delta }
        : raw;
      let protocolType: string = e.type;
      let protocolPayload = normalized;
      if (e.type === "message_start") protocolType = "message.started";
      else if (e.type === "message_update") {
        protocolType = "message.delta";
        protocolPayload = { delta: messageEvent?.delta ?? raw.delta ?? "", raw: normalized };
      } else if (e.type === "message_end") protocolType = "message.completed";
      else if (e.type === "tool_execution_start") {
        protocolType = "tool.started";
        protocolPayload = { toolCallId: raw.toolCallId, toolName: raw.toolName, args: raw.args ?? raw.input };
      } else if (e.type === "tool_execution_update") {
        protocolType = "tool.updated";
        protocolPayload = { toolCallId: raw.toolCallId, toolName: raw.toolName, update: raw.partialResult ?? raw.update };
      } else if (e.type === "tool_execution_end") {
        const result = raw.result as { isError?: boolean } | undefined;
        protocolType = result?.isError ? "tool.failed" : "tool.completed";
        protocolPayload = { toolCallId: raw.toolCallId, toolName: raw.toolName, result: raw.result, isError: result?.isError ?? false };
      } else if (e.type === "agent_start") protocolType = "turn.started";
      else if (e.type === "agent_end") protocolType = "turn.completed";
      this.push(protocolType, protocolPayload, sessionId, runId);
      if (!runId) return;
      const payload = normalized;
      const p = payload as { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; message?: unknown; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
      const delta = p.assistantMessageEvent?.delta;
      if (typeof delta === "string" && delta) this.hooks.onMessage?.(sessionId, runId, "assistant", delta);
      if (e.type === "tool_execution_start") this.hooks.onTool?.(sessionId, runId, "start", String(p.toolName ?? "tool"), p.args, undefined, p.toolCallId);
      if (e.type === "tool_execution_end") this.hooks.onTool?.(sessionId, runId, "end", String(p.toolName ?? "tool"), p.args, p.result, p.toolCallId);
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
    opts: { model?: string; cwd?: string; runId?: string },
    runEmit: RunEmitFn
  ): Promise<void> {
    if (this.activeRunIds.has(sessionId)) throw new Error(`session ${sessionId} already has an active run`);
    const runId = opts.runId ?? crypto.randomUUID();
    this.activeRunIds.set(sessionId, runId);
    let session: AgentSession | undefined;
    try {
      session = await this.getSession(sessionId, opts.cwd, opts.model);
      if (this.stoppedRuns.has(runId)) throw new Error("run aborted");
      this.runs.set(runId, session);
      await session.prompt(message);
      runEmit("agent.prompt_done", { runId });
    } finally {
      this.runs.delete(runId);
      this.stoppedRuns.delete(runId);
      if (this.activeRunIds.get(sessionId) === runId) this.activeRunIds.delete(sessionId);
      if (session && this.staleSessions.has(sessionId) && session.isIdle) {
        session.dispose();
        this.sessions.delete(sessionId);
        this.staleSessions.delete(sessionId);
        await this.sessionToolDisposer?.(sessionId);
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
