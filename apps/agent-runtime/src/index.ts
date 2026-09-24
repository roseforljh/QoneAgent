import { createLogger, EventBus, SequencedEventJournal } from "@qone/shared";
import type { RuntimeCommand, RuntimeEvent, AgentEvent, AssistantMessagePart, SessionInfo, WorkspaceInfo, PermissionDecision, WorkspaceFileInfo } from "@qone/protocol";
import { encode, decodeCommand, assistantPartsFromPiMessage, applyAssistantToolEvent } from "@qone/protocol";
import { openDb, SessionRepo, MessageRepo, RunRepo, TurnRepo, WorkspaceRepo, ToolCallRepo, McpServerRepo, ModelConfigRepo, SettingsRepo, EventRepo, ArtifactRepo, PermissionRepo, SkillRepo } from "@qone/database";
import { McpManager } from "@qone/mcp";
import { PiAdapter } from "./pi-adapter.js";
import { ApprovalQueue } from "./permissions.js";
import path from "node:path";
import { existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { createResourceLoader } from "./skills.js";
import { containsSecretConfig } from "./secrets.js";
import { ModelMetadataResolver } from "./model-resolver.js";

const log = createLogger("runtime");

interface RuntimeBusEvent {
  type: string;
  payload: unknown;
  sessionId?: string;
  runId?: string;
}

const eventBus = new EventBus<RuntimeBusEvent>();

// NDJSON over stdio: one JSON object per line on stdout.
// stderr is reserved for logs.
const send = (msg: RuntimeEvent) => process.stdout.write(encode(msg));

// --- persistence ---
const dbPath =
  process.env.QONE_DB ??
  path.join(process.env.APPDATA ?? process.env.HOME ?? process.cwd(), "QoneAgent", "agent.db");
const dbDir = path.dirname(dbPath);
if (dbDir !== ".") mkdirSync(dbDir, { recursive: true });
const db = openDb(dbPath);
const sessionRepo = new SessionRepo(db);
const messageRepo = new MessageRepo(db);
const runRepo = new RunRepo(db);
const turnRepo = new TurnRepo(db);
const workspaceRepo = new WorkspaceRepo(db);
const toolCallRepo = new ToolCallRepo(db);
const mcpServerRepo = new McpServerRepo(db);
const modelConfigRepo = new ModelConfigRepo(db);
const runtimeSecrets = new Map<string, string>();
const settingsMetadataResolver = new ModelMetadataResolver();
const settingsRepo = new SettingsRepo(db);
const eventRepo = new EventRepo(db);
const artifactRepo = new ArtifactRepo(db);
const permissionRepo = new PermissionRepo(db);
const skillRepo = new SkillRepo(db);
const eventJournal = new SequencedEventJournal<AgentEvent>(settingsRepo.get<number>("event.sequence") ?? 0);
eventJournal.restore(eventRepo.list());
const pendingEvents: AgentEvent[] = [];
let eventFlushTimer: ReturnType<typeof setTimeout> | undefined;
const flushEvents = () => {
  if (eventFlushTimer) clearTimeout(eventFlushTimer);
  eventFlushTimer = undefined;
  if (pendingEvents.length === 0) return;
  const batch = pendingEvents.splice(0, pendingEvents.length);
  eventRepo.addMany(batch);
  const last = batch.at(-1);
  if (last) settingsRepo.set("event.sequence", last.sequence + 1);
};
const queueEventPersistence = (event: AgentEvent) => {
  pendingEvents.push(event);
  if (pendingEvents.length >= 50) flushEvents();
  else if (!eventFlushTimer) eventFlushTimer = setTimeout(flushEvents, 32);
};

eventBus.subscribe((busEvent) => {
  if (busEvent.type === "approval.requested" && busEvent.runId) {
    runRepo.setStatus(busEvent.runId, "waiting_approval");
    const payload = busEvent.payload as { approvalId?: string; toolCallId?: string };
    if (payload.approvalId) {
      approvalRuns.set(payload.approvalId, busEvent.runId);
      if (payload.toolCallId) {
        const toolCallId = toolCallIds.get(`${busEvent.runId}:${payload.toolCallId}`);
        if (toolCallId) {
          toolCallRepo.setStatus(toolCallId, "waiting_approval");
          approvalToolCalls.set(payload.approvalId, toolCallId);
        }
      }
    }
  }
  const agentEvent = eventJournal.record((sequence) => ({
    eventId: crypto.randomUUID(), sequence, type: busEvent.type,
    sessionId: busEvent.sessionId, runId: busEvent.runId,
    timestamp: Date.now(), payload: busEvent.payload,
  } satisfies AgentEvent));
  if (agentEvent.runId) {
    const parts = assistantPartsByRun.get(agentEvent.runId);
    if (parts) {
      const messageRole = (agentEvent.payload as { message?: { role?: unknown } } | undefined)?.message?.role;
      if (agentEvent.type === "message.started" && messageRole === "assistant") {
        assistantMessageSequenceByRun.set(agentEvent.runId, agentEvent.sequence);
      } else if (agentEvent.type === "message.completed" && messageRole === "assistant") {
        const messageSequence = assistantMessageSequenceByRun.get(agentEvent.runId) ?? agentEvent.sequence;
        parts.push(...assistantPartsFromPiMessage(agentEvent.payload, messageSequence));
        assistantMessageSequenceByRun.delete(agentEvent.runId);
      } else if (agentEvent.type === "tool.started" || agentEvent.type === "tool.completed" || agentEvent.type === "tool.failed") {
        assistantPartsByRun.set(agentEvent.runId, applyAssistantToolEvent(parts, agentEvent.type, agentEvent.payload));
      }
    }
  }
  queueEventPersistence(agentEvent);
  send({ type: "agent.event", event: agentEvent });
});
const assistantBuffers = new Map<string, string>();
const assistantPartsByRun = new Map<string, AssistantMessagePart[]>();
const assistantMessageSequenceByRun = new Map<string, number>();
const toolCallIds = new Map<string, string>();
const cancelledRuns = new Set<string>();
const startingRunSessions = new Set<string>();
const approvalRuns = new Map<string, string>();
const approvalToolCalls = new Map<string, string>();
const commandApprovals = new ApprovalQueue();
runRepo.markInterrupted(); // any run still "running" was killed with last process
turnRepo.markInterrupted();
toolCallRepo.markInterrupted();

const adapter = new PiAdapter((event) => eventBus.emit({
  type: event.type,
  payload: event.payload,
  sessionId: event.sessionId,
  runId: event.runId,
}), {
  onAssistantFinal: (_sessionId, runId, content) => {
    if (content.trim()) assistantBuffers.set(runId, content);
  },
  onTool: (sessionId, runId, phase, name, args, result, toolCallId) => {
    if (phase === "start") {
      const row = toolCallRepo.start(runId, name, args, toolCallId);
      if (toolCallId) toolCallIds.set(`${runId}:${toolCallId}`, row.id);
    } else if (toolCallId) {
      const id = toolCallIds.get(`${runId}:${toolCallId}`);
      if (id) {
        toolCallRepo.finish(id, result && (result as { isError?: boolean }).isError ? "failed" : "success", result);
        toolCallIds.delete(`${runId}:${toolCallId}`);
      }
    }
  },
}, permissionRepo, (sessionId, currentRunId) => messageRepo.listBySession(sessionId).filter((message) => message.runId !== currentRunId).map((message) => ({
  role: message.role,
  content: message.content,
  attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
  createdAt: message.createdAt,
})));
await adapter.configureModels(modelConfigRepo.list());
for (const [permission, decision] of [
  ["filesystem.write", "ask"],
  ["shell.execute", "ask"],
  ["network", "ask"],
  ["clipboard.read", "ask"],
  ["clipboard.write", "ask"],
  ["windows.control", "ask"],
  ["secret.read", "ask"],
  ["mcp.connect", "ask"],
  ["tool.execute", "ask"],
] as const) permissionRepo.ensure("builtin", permission, decision);
const mcp = new McpManager(async (serverId, token) => {
  const config = mcpServerRepo.list().find((server) => server.id === serverId);
  const key = config?.oauth?.tokenSecretKey ?? `mcp.oauth:${serverId}`;
  runtimeSecrets.set(key, token);
  send({ type: "mcp.oauth.token", requestId: "oauth-callback", serverId, key, accessToken: token });
  if (config) {
    await mcp.disconnect(serverId);
    try {
      const tools = await mcp.connect(config);
      await refreshCustomTools();
      send({ type: "mcp.connected", serverId, toolCount: tools.length });
    } catch (error) {
      log.warn("MCP OAuth reconnect failed", { serverId, err: String(error) });
    }
  }
});
for (const config of [...mcpServerRepo.list(), ...loadMcpConfigs()]) {
  const subjectId = `mcp:${config.id}`;
  permissionRepo.ensure(subjectId, "mcp.connect", "ask");
  if (permissionRepo.get(subjectId, "mcp.connect") !== "allow") continue;
  try {
    await mcp.connect(config);
    log.info("mcp connected", { serverId: config.id });
  } catch (err) {
    log.warn("mcp connection failed", { serverId: config.id, err: String(err) });
  }
}
await refreshCustomTools();

async function refreshCustomTools() {
  await adapter.setCustomTools(mcp.tools());
}

function loadMcpConfigs() {
  const raw = process.env.QONE_MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed).map(([id, value]) => ({ id, ...(value as object) }))) as Array<{
      id: string; name: string; command: string; args?: string[]; env?: Record<string, string>;
    }>;
  } catch (err) {
    log.warn("invalid QONE_MCP_SERVERS", { err: String(err) });
    return [];
  }
}

function listWorkspaceFiles(root: string, max = 1000): WorkspaceFileInfo[] {
  const result: WorkspaceFileInfo[] = [];
  const ignored = new Set([".git", "node_modules", "dist", "target", ".test-data"]);
  const walk = (current: string, relative: string) => {
    if (result.length >= max) return;
    let entries;
    try { entries = readdirSync(current, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (result.length >= max || ignored.has(entry.name)) continue;
      const rel = relative ? path.join(relative, entry.name) : entry.name;
      result.push({ path: rel, kind: entry.isDirectory() ? "directory" : "file" });
      if (entry.isDirectory()) walk(path.join(current, entry.name), rel);
    }
  };
  walk(root, "");
  return result;
}

async function gitStatus(root: string): Promise<string> {
  try {
    const process = Bun.spawn(["git", "-C", root, "status", "--short"], { stdout: "pipe", stderr: "pipe" });
    const output = await new Response(process.stdout).text();
    await process.exited;
    return output.slice(0, 20_000);
  } catch (error) {
    return `git status unavailable: ${String(error)}`;
  }
}

const toInfo = (s: {
  id: string;
  title: string;
  workspaceId: string | null | undefined;
  createdAt: number;
  updatedAt: number;
}): SessionInfo => ({
  id: s.id,
  title: s.title,
  workspaceId: s.workspaceId ?? undefined,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
});

const emit = (type: string, payload: unknown, sessionId?: string, runId?: string) =>
  eventBus.emit({ type, payload, sessionId, runId });

async function authorizeCommand(subjectId: string, permission: string, toolName: string, args: unknown) {
  const decision = permissionRepo.get(subjectId, permission) ?? "ask";
  if (decision === "deny") throw new Error(`${toolName} denied by permission policy`);
  if (decision === "allow") return;
  const approvalId = crypto.randomUUID();
  const approval = commandApprovals.request(approvalId, toolName, args);
  emit("approval.requested", { approvalId, toolName, args });
  if (!await approval) throw new Error(`${toolName} rejected by user`);
}

async function handle(cmd: RuntimeCommand): Promise<void> {
  switch (cmd.type) {
    case "ping":
      send({ type: "pong", requestId: cmd.requestId, capabilities: ["model.resolve-metadata", "model.metadata-sources"] });
      return;

    case "session.create": {
      if (cmd.workspaceId && !workspaceRepo.get(cmd.workspaceId)) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown workspace ${cmd.workspaceId}` });
        return;
      }
      const s = sessionRepo.create(cmd.title, cmd.workspaceId);
      send({ type: "session.created", session: toInfo(s) });
      return;
    }

    case "session.generate-title": {
      const fallback = cmd.prompt.replace(/\s+/g, " ").trim().slice(0, 40) || "New session";
      try {
        const title = await adapter.generateTitle(cmd.prompt, cmd.model).catch(() => fallback);
        send({ type: "session.renamed", session: toInfo(sessionRepo.rename(cmd.sessionId, title)) });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, message: String(error) });
      }
      return;
    }

    case "session.list":
      send({ type: "session.list", sessions: sessionRepo.list().map(toInfo) });
      return;

    case "session.rename": {
      try {
        send({ type: "session.renamed", session: toInfo(sessionRepo.rename(cmd.sessionId, cmd.title)) });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, message: String(error) });
      }
      return;
    }

    case "session.delete":
      await adapter.disposeSession(cmd.sessionId);
      sessionRepo.delete(cmd.sessionId);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "session.messages":
      send({
        type: "session.messages",
        sessionId: cmd.sessionId,
        messages: messageRepo.listBySession(cmd.sessionId).map((m) => ({
          id: m.id,
          sessionId: m.sessionId,
          runId: m.runId ?? undefined,
          role: m.role,
          content: m.content,
          parts: m.parts ? JSON.parse(m.parts) as AssistantMessagePart[] : undefined,
          attachments: m.attachments ? JSON.parse(m.attachments) : undefined,
          model: m.model ?? undefined,
          createdAt: m.createdAt,
        })),
      });
      return;

    case "session.runs":
      send({
        type: "session.runs",
        sessionId: cmd.sessionId,
        runs: runRepo.listBySession(cmd.sessionId).map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          status: r.status as never,
          startedAt: r.startedAt ?? undefined,
          completedAt: r.completedAt ?? undefined,
          error: r.error ?? undefined,
        })),
      });
      return;

    case "session.toolCalls":
      send({ type: "session.toolCalls", sessionId: cmd.sessionId, toolCalls: toolCallRepo.listBySession(cmd.sessionId).map((t) => ({
        id: t.id, runId: t.runId, toolName: t.toolName,
        arguments: t.arguments ?? undefined, resultSummary: t.resultSummary ?? undefined,
        status: t.status, startedAt: t.startedAt ?? undefined, completedAt: t.completedAt ?? undefined,
      })) });
      return;

    case "artifact.list":
      send({ type: "artifact.list", sessionId: cmd.sessionId, artifacts: artifactRepo.listBySession(cmd.sessionId).map((artifact) => ({
        id: artifact.id, sessionId: artifact.sessionId, type: artifact.type, name: artifact.name,
        path: artifact.path, mimeType: artifact.mimeType ?? undefined, size: artifact.size ?? undefined, createdAt: artifact.createdAt,
      })) });
      return;

    case "workspace.list":
      send({ type: "workspace.list", workspaces: workspaceRepo.list() as WorkspaceInfo[] });
      return;

    case "workspace.upsert": {
      const workspacePath = path.resolve(cmd.path);
      if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
        send({ type: "error", requestId: cmd.requestId, message: `workspace directory does not exist: ${cmd.path}` });
        return;
      }
      send({ type: "workspace.updated", workspace: workspaceRepo.upsert(cmd.name, workspacePath) as WorkspaceInfo });
      return;
    }

    case "workspace.rename": {
      try {
        send({ type: "workspace.renamed", workspace: workspaceRepo.rename(cmd.workspaceId, cmd.name) as WorkspaceInfo });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, message: String(error) });
      }
      return;
    }

    case "workspace.delete":
      if (!workspaceRepo.get(cmd.workspaceId)) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown workspace ${cmd.workspaceId}` });
        return;
      }
      workspaceRepo.delete(cmd.workspaceId);
      send({ type: "workspace.deleted", workspaceId: cmd.workspaceId });
      return;

    case "workspace.files": {
      const workspace = workspaceRepo.get(cmd.workspaceId);
      if (!workspace) { send({ type: "error", requestId: cmd.requestId, message: "unknown workspace" }); return; }
      send({ type: "workspace.files", workspaceId: workspace.id, files: listWorkspaceFiles(workspace.path) });
      return;
    }

    case "workspace.git": {
      const workspace = workspaceRepo.get(cmd.workspaceId);
      if (!workspace) { send({ type: "error", requestId: cmd.requestId, message: "unknown workspace" }); return; }
      send({ type: "workspace.git", workspaceId: workspace.id, status: await gitStatus(workspace.path) });
      return;
    }

    case "skills.list": {
      const requestedCwd = cmd.cwd ? path.resolve(cmd.cwd) : process.cwd();
      if (cmd.cwd && !workspaceRepo.list().some((workspace) => path.resolve(workspace.path).toLowerCase() === requestedCwd.toLowerCase())) {
        send({ type: "error", requestId: cmd.requestId, message: "skills path is outside registered workspaces" });
        return;
      }
      const { skills } = await createResourceLoader(requestedCwd);
      for (const skill of skills) skillRepo.upsert(skill);
      send({ type: "skills.list", skills });
      return;
    }

    case "plugins.list":
      send({ type: "plugins.list", plugins: [] });
      return;

    case "mcp.list":
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      return;

    case "mcp.connect": {
      const subjectId = `mcp:${cmd.config.id}`;
      permissionRepo.ensure(subjectId, "mcp.connect", "ask");
      await authorizeCommand(subjectId, "mcp.connect", "mcp.connect", { id: cmd.config.id, name: cmd.config.name, command: cmd.config.command, url: cmd.config.url });
      mcpServerRepo.upsert(cmd.config);
      await mcp.disconnect(cmd.config.id);
      const tools = await mcp.connect(cmd.config);
      await adapter.setCustomTools(mcp.tools());
      send({ type: "mcp.connected", serverId: cmd.config.id, toolCount: tools.length });
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      return;
    }

    case "mcp.delete": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown MCP server ${cmd.serverId}` });
        return;
      }
      await mcp.disconnect(cmd.serverId);
      mcpServerRepo.delete(cmd.serverId);
      await adapter.deleteSecret(config.oauth?.tokenSecretKey ?? `mcp.oauth:${cmd.serverId}`);
      await refreshCustomTools();
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      return;
    }

    case "mcp.oauth.begin": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      await authorizeCommand(`mcp:${config.id}`, "mcp.connect", "mcp.oauth", { id: config.id, name: config.name });
      const auth = await mcp.beginOAuth(config);
      send({ type: "mcp.oauth.authorization", requestId: cmd.requestId, serverId: cmd.serverId, url: auth.url, state: auth.state });
      return;
    }

    case "mcp.oauth.complete": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      await mcp.completeOAuth(config, cmd.code, cmd.state);
      // completeOAuth emits the token event and reconnects through the same
      // callback for browser redirects and manual code entry.
      return;
    }

    case "permission.list":
      send({ type: "permission.list", rules: permissionRepo.list().map((rule) => ({
        subjectId: rule.subjectId,
        permission: rule.permission,
        decision: rule.decision as PermissionDecision,
        updatedAt: rule.updatedAt,
      })) });
      return;

    case "permission.set": {
      const rule = permissionRepo.set(cmd.subjectId, cmd.permission, cmd.decision);
      send({ type: "permission.updated", rule: {
        subjectId: rule.subjectId,
        permission: rule.permission,
        decision: rule.decision,
        updatedAt: rule.updatedAt,
      } });
      return;
    }

    case "model.list":
      await adapter.configureModels(modelConfigRepo.list());
      send({ type: "model.list", configs: modelConfigRepo.list() });
      return;

    case "model.resolve-metadata": {
      const models = await Promise.all(cmd.models.map(async ({ id, metadata }) => {
        const resolved = await settingsMetadataResolver.resolve({ provider: cmd.provider, model: id, config: { apiType: cmd.apiType, baseUrl: cmd.baseUrl, autoMetadata: true, modelMetadata: metadata } });
        const thinkingLevels = Object.entries(resolved.thinkingLevelMap ?? {}).filter(([level, value]) => level !== "off" && value !== null && value !== undefined).map(([level]) => level);
        return { id, metadata: resolved.metadata, thinkingLevels, sources: resolved.sources };
      }));
      send({ type: "model.metadata-resolved", requestId: cmd.requestId, models });
      return;
    }

    case "model.upsert": {
      if (containsSecretConfig(cmd.config.config)) {
        send({ type: "error", requestId: cmd.requestId, message: "model secrets must be stored in Windows Credential Manager" });
        return;
      }
      const config = modelConfigRepo.upsert(cmd.config);
      await adapter.configureModels(modelConfigRepo.list());
      send({ type: "model.updated", config });
      return;
    }

    case "model.delete":
      modelConfigRepo.delete(cmd.id);
      await adapter.configureModels(modelConfigRepo.list());
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "events.replay": {
      const after = cmd.afterSequence ?? -1;
      send({
        type: "events.replay",
        events: eventJournal.replay(after, cmd.sessionId),
      });
      return;
    }

    case "secret.set": {
      runtimeSecrets.set(cmd.key, cmd.value);
      const mcpSecret = mcpServerRepo.list().find((server) =>
        server.oauth?.tokenSecretKey === cmd.key || `mcp.oauth:${server.id}` === cmd.key);
      if (mcpSecret) {
        mcp.setAccessToken(mcpSecret.id, cmd.value);
        if (permissionRepo.get(`mcp:${mcpSecret.id}`, "mcp.connect") === "allow") {
          try {
            await mcp.disconnect(mcpSecret.id);
            await mcp.connect(mcpSecret);
            await adapter.setCustomTools(mcp.tools());
          } catch (error) {
            log.warn("MCP OAuth credential restore failed", { serverId: mcpSecret.id, err: String(error) });
          }
        }
      }
      await adapter.setSecret(cmd.key, cmd.value);
      send({ type: "secret.saved", requestId: cmd.requestId });
      return;
    }

    case "secret.delete":
      runtimeSecrets.delete(cmd.key);
      await adapter.deleteSecret(cmd.key);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "agent.run": {
      const s = sessionRepo.get(cmd.sessionId);
      if (!s) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown session ${cmd.sessionId}` });
        return;
      }
      if (!s.workspaceId) {
        send({ type: "error", requestId: cmd.requestId, message: "select a workspace before running the agent" });
        return;
      }
      if (startingRunSessions.has(cmd.sessionId) || adapter.isRunning(cmd.sessionId) ||
          runRepo.listBySession(cmd.sessionId).some((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status))) {
        send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return;
      }
      if (cmd.replaceFromMessageId) {
        startingRunSessions.add(cmd.sessionId);
        try {
          // Pi keeps an in-memory conversation; it must be rebuilt from the trimmed DB history.
          await adapter.disposeSession(cmd.sessionId);
          flushEvents();
          messageRepo.truncateFrom(cmd.sessionId, cmd.replaceFromMessageId);
          eventJournal.restore(eventRepo.list());
        } catch (error) {
          send({ type: "error", requestId: cmd.requestId, message: String(error) });
          return;
        } finally {
          startingRunSessions.delete(cmd.sessionId);
        }
      }
      const run = runRepo.create(cmd.sessionId);
      assistantPartsByRun.set(run.id, []);
      const turn = turnRepo.create(run.id);
      messageRepo.add(cmd.sessionId, "user", cmd.message, run.id, undefined, cmd.messageId, cmd.attachments);
      emit("agent.started", { runId: run.id }, cmd.sessionId, run.id);
      const workspaceCwd = s.workspaceId ? workspaceRepo.get(s.workspaceId)?.path : undefined;
      if (s.workspaceId && !workspaceCwd) {
        runRepo.finish(run.id, "failed", "session workspace no longer exists");
        assistantPartsByRun.delete(run.id);
        assistantMessageSequenceByRun.delete(run.id);
        turnRepo.finish(turn.id, "failed");
        emit("agent.failed", { message: "session workspace no longer exists" }, cmd.sessionId, run.id);
        send({ type: "error", requestId: cmd.requestId, message: "session workspace no longer exists" });
        return;
      }

      Promise.resolve()
        .then(() => adapter.run(cmd.sessionId, cmd.message, { model: cmd.model, cwd: workspaceCwd, runId: run.id, permissionMode: cmd.permissionMode, thinking: cmd.thinking, attachments: cmd.attachments }, (type, payload) =>
          emit(type, payload, cmd.sessionId, run.id)
        ))
        .then(() => {
          const assistant = assistantBuffers.get(run.id);
          if (!assistant?.trim() && !cancelledRuns.has(run.id)) throw new Error("AI returned an empty response");
          const parts = assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = assistant?.trim()
            ? messageRepo.addAssistant(cmd.sessionId, assistant, run.id, cmd.model, parts)
            : undefined;
          assistantBuffers.delete(run.id);
          assistantPartsByRun.delete(run.id);
          assistantMessageSequenceByRun.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const cancelled = cancelledRuns.delete(run.id);
          const status = cancelled ? "cancelled" : "completed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status);
          sessionRepo.touch(cmd.sessionId);
          emit(cancelled ? "agent.cancelled" : "agent.completed", assistantMessage ? {
            message: {
              id: assistantMessage.id,
              role: assistantMessage.role,
              content: assistantMessage.content,
              parts,
              runId: assistantMessage.runId,
              createdAt: assistantMessage.createdAt,
            },
          } : {}, cmd.sessionId, run.id);
        })
        .catch((err) => {
          assistantBuffers.delete(run.id);
          assistantPartsByRun.delete(run.id);
          assistantMessageSequenceByRun.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const cancelled = cancelledRuns.delete(run.id);
          const status = cancelled ? "cancelled" : "failed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status, cancelled ? undefined : String(err));
          emit(cancelled ? "agent.cancelled" : "agent.failed", cancelled ? {} : { message: String(err) }, cmd.sessionId, run.id);
        });

      send({ type: "pong", requestId: cmd.requestId });
      return;
    }

    case "agent.stop":
      if (!adapter.stop(cmd.runId)) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown active run ${cmd.runId}` });
        return;
      }
      cancelledRuns.add(cmd.runId);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "tool.approve":
      adapter.approve(cmd.approvalId);
      commandApprovals.approve(cmd.approvalId);
      if (approvalRuns.has(cmd.approvalId)) {
        const runId = approvalRuns.get(cmd.approvalId)!;
        runRepo.setStatus(runId, "running");
        const toolCallId = approvalToolCalls.get(cmd.approvalId);
        if (toolCallId) toolCallRepo.setStatus(toolCallId, "running");
        const run = runRepo.get(runId);
        if (run) emit("run.status", { status: "running" }, run.sessionId, runId);
      }
      approvalRuns.delete(cmd.approvalId);
      approvalToolCalls.delete(cmd.approvalId);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "tool.reject":
      adapter.reject(cmd.approvalId);
      commandApprovals.reject(cmd.approvalId);
      if (approvalRuns.has(cmd.approvalId)) {
        const runId = approvalRuns.get(cmd.approvalId)!;
        runRepo.setStatus(runId, "running");
        const toolCallId = approvalToolCalls.get(cmd.approvalId);
        if (toolCallId) toolCallRepo.setStatus(toolCallId, "running");
        const run = runRepo.get(runId);
        if (run) emit("run.status", { status: "running" }, run.sessionId, runId);
      }
      approvalRuns.delete(cmd.approvalId);
      approvalToolCalls.delete(cmd.approvalId);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    default:
      send({
        type: "error",
        requestId: (cmd as { requestId?: string }).requestId,
        message: `unhandled command ${(cmd as { type: string }).type}`,
      });
  }
}

// Read NDJSON commands from stdin.
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buf = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const cmd = decodeCommand(line);
    if (!cmd) {
      // A newer GUI may send a command this runtime does not know. Reply to
      // correlated requests instead of leaving the GUI waiting for a timeout.
      try {
        const raw = JSON.parse(line) as { requestId?: unknown; type?: unknown };
        if (typeof raw.requestId === "string") send({ type: "error", requestId: raw.requestId, message: `invalid or unsupported command: ${String(raw.type ?? "unknown")}` });
      } catch { /* Ignore malformed input without a request ID. */ }
      continue;
    }
    handle(cmd).catch((err) => {
      log.error("command failed", { err: String(err) });
      send({ type: "error", requestId: cmd.requestId, message: String(err) });
    });
  }
}

await mcp.disconnectAll();
for (const session of adapter.getSessions()) {
  try { await session.dispose(); } catch (error) { log.warn("Pi session dispose failed", { err: String(error) }); }
}
flushEvents();
