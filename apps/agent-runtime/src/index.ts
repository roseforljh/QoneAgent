import { createLogger, EventBus, SequencedEventJournal } from "@qone/shared";
import type { RuntimeCommand, RuntimeEvent, AgentEvent, AssistantMessagePart, SessionInfo, WorkspaceInfo, PermissionDecision } from "@qone/protocol";
import { encode, decodeCommand, assistantPartsFromPiMessage, applyAssistantToolEvent, thinkingLevelsForApi } from "@qone/protocol";
import { openDb, SessionRepo, MessageRepo, RunRepo, TurnRepo, WorkspaceRepo, ToolCallRepo, McpServerRepo, ModelConfigRepo, SettingsRepo, EventRepo, ArtifactRepo, PermissionRepo, SkillRepo } from "@qone/database";
import { McpManager } from "@qone/mcp";
import { PiAdapter } from "./pi-adapter.js";
import { ApprovalQueue } from "./permissions.js";
import path from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { createResourceLoader } from "./skills.js";
import { installCloudSkill, listCloudSkills } from "./skill-catalog.js";
import { containsSecretConfig } from "./secrets.js";
import { ModelMetadataResolver } from "./model-resolver.js";
import { BrowserSyncService } from "./browser-sync.js";
import { createReachPublicTools } from "./reach-public-tools.js";
import { listReachChannels, ytDlpExecutable } from "./reach-channels.js";
import { configurePodcast, podcastConfigured } from "./reach-podcast.js";
import { createPodcastTools } from "./reach-podcast-tools.js";
import { listWorkspaceFiles, readWorkspaceFile, workspaceGit, workspaceDiff } from "./workspace.js";

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
// Raw streamed deltas per run; survives aborts so partial answers can be saved.
const assistantStreamBuffers = new Map<string, string>();
const assistantPartsByRun = new Map<string, AssistantMessagePart[]>();
const assistantMessageSequenceByRun = new Map<string, number>();
const toolCallIds = new Map<string, string>();
const cancelledRuns = new Set<string>();
const startingRunSessions = new Set<string>();

// Persist whatever the run produced so far (final text, streamed deltas, tool parts).
function persistPartialAssistant(sessionId: string, runId: string, model?: string) {
  const parts = assistantPartsByRun.get(runId) ?? [];
  const streamText = assistantStreamBuffers.get(runId)?.trim() ?? "";
  const partsText = parts
    .filter((part): part is Extract<AssistantMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
  const content = streamText || assistantBuffers.get(runId)?.trim() || partsText;
  if (!content && !parts.length) return undefined;
  return messageRepo.addAssistant(sessionId, content, runId, model, parts);
}
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
  onMessage: (_sessionId, runId, role, delta) => {
    if (role === "assistant") assistantStreamBuffers.set(runId, (assistantStreamBuffers.get(runId) ?? "") + delta);
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
  ["mcp.execute", "ask"],
  ["tool.execute", "ask"],
] as const) permissionRepo.ensure("builtin", permission, decision);
const pendingMcpAuthRequests = new Map<string, string>();
const mcp = new McpManager(async (serverId, token) => {
  const config = mcpServerRepo.list().find((server) => server.id === serverId);
  if (token) {
    const key = config?.oauth?.tokenSecretKey ?? `mcp.oauth:${serverId}`;
    runtimeSecrets.set(key, token);
    send({ type: "mcp.oauth.token", requestId: "oauth-callback", serverId, key, accessToken: token });
  }
  if (config) {
    await mcp.disconnect(serverId);
    try {
      const tools = await mcp.connect(config);
      await refreshCustomTools();
      send({ type: "mcp.connected", serverId, toolCount: tools.length });
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      pendingMcpAuthRequests.delete(serverId);
    } catch (error) {
      log.warn("MCP OAuth reconnect failed", { serverId, err: String(error) });
      const requestId = pendingMcpAuthRequests.get(serverId);
      if (requestId) send({ type: "error", requestId, message: String(error) });
      pendingMcpAuthRequests.delete(serverId);
    }
  }
}, (serverId, kind, value) => {
  send({ type: "mcp.oauth.credential", serverId, key: `mcp.oauth:${serverId}.${kind}`, value });
}, (serverId, authorization) => {
  send({ type: "mcp.oauth.authorization", requestId: pendingMcpAuthRequests.get(serverId) ?? crypto.randomUUID(), serverId, ...authorization });
}, (serverId, error) => {
  const requestId = pendingMcpAuthRequests.get(serverId);
  pendingMcpAuthRequests.delete(serverId);
  if (requestId) send({ type: "error", requestId, message: error.message });
}, (key) => runtimeSecrets.get(key));
for (const config of [...mcpServerRepo.list(), ...loadMcpConfigs()]) {
  // Playwright remains available as a manually enabled fallback. OpenCLI is
  // the default browser channel, so starting Playwright here would launch a
  // second browser and compete with the current Chrome connection.
  if (config.id === "mcp-playwright") continue;
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
let browserSync: BrowserSyncService | undefined;
await refreshCustomTools();
browserSync = new BrowserSyncService(db, dbPath,
  (status) => {
    send({ type: "browser.status", status });
    sendReachChannels();
  }, refreshCustomTools);
await browserSync.initialize();

async function releaseBrowserSession() {
  try { await browserSync?.release(); }
  catch (error) { log.warn("browser session release failed", { err: String(error) }); }
}

async function refreshCustomTools() {
  await adapter.setCustomTools([
    ...mcp.tools(),
    ...createReachPublicTools({ ytDlp: ytDlpExecutable, xueqiuCookie: () => runtimeSecrets.get("reach.xueqiu.cookie") }),
    ...createPodcastTools(() => runtimeSecrets.get("reach.groq.apiKey")),
    ...(browserSync?.tools() ?? []),
  ]);
}

function sendReachChannels(requestId?: string) {
  send({ type: "reach.channels", requestId, channels: listReachChannels({
    browserConnected: browserSync?.status().targetConnected ?? false,
    mcpConnected: (id) => mcp.isConnected(id),
    hasXueqiuCookie: Boolean(runtimeSecrets.get("reach.xueqiu.cookie")),
    podcastConfigured: podcastConfigured(),
    hasGroqKey: Boolean(runtimeSecrets.get("reach.groq.apiKey")),
  }) });
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
      send({
        type: "pong",
        requestId: cmd.requestId,
        capabilities: [
          "model.resolve-metadata",
          "model.metadata-sources",
          "workspace.explorer.v2",
          "workspace.files",
          "workspace.git",
          "workspace.gitDiff",
          "file.read",
          "browser.connect",
          "reach.channels",
          "reach.podcast.configure",
        ],
      });
      return;

    case "session.create": {
      if (!workspaceRepo.get(cmd.workspaceId)) {
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

    case "session.list": {
      const workspaceIds = new Set(workspaceRepo.list().map((workspace) => workspace.id));
      send({
        type: "session.list",
        sessions: sessionRepo.list()
          .filter((session) => session.workspaceId && workspaceIds.has(session.workspaceId))
          .map(toInfo),
      });
      return;
    }

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

    case "workspace.files":
    case "workspace.git":
    case "workspace.gitDiff":
    case "file.read": {
      const workspace = workspaceRepo.get(cmd.workspaceId);
      if (!workspace) throw new Error("Unknown workspace");
      const context = { requestId: cmd.requestId, workspaceId: workspace.id };
      if (cmd.type === "workspace.files") {
        send({ type: cmd.type, ...context, path: cmd.path ?? "", files: await listWorkspaceFiles(workspace.path, cmd.path) });
      } else if (cmd.type === "workspace.git") {
        send({ type: cmd.type, ...context, ...await workspaceGit(workspace.path) });
      } else if (cmd.type === "workspace.gitDiff") {
        send({ type: cmd.type, ...context, path: cmd.path, ...await workspaceDiff(workspace.path, cmd.path, cmd.scope) });
      } else {
        send({ type: cmd.type, ...context, path: cmd.path, ...await readWorkspaceFile(workspace.path, cmd.path) });
      }
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

    case "skills.cloud.list": {
      const page = await listCloudSkills(cmd.collection, cmd.page, cmd.query);
      send({ type: "skills.cloud.list", requestId: cmd.requestId, ...page });
      return;
    }
    case "skills.cloud.install": {
      const skill = await installCloudSkill(cmd.source, cmd.skillId);
      await adapter.refreshSkills();
      skillRepo.upsert(skill);
      send({ type: "skills.cloud.installed", requestId: cmd.requestId, skill });
      return;
    }

    case "plugins.list":
      send({ type: "plugins.list", plugins: [] });
      return;

    case "browser.status":
      send({ type: "browser.status", requestId: cmd.requestId, status: browserSync!.status() });
      return;

    case "reach.channels":
      sendReachChannels(cmd.requestId);
      return;

    case "reach.podcast.configure":
      configurePodcast(cmd.accessToken, cmd.refreshToken);
      send({ type: "pong", requestId: cmd.requestId });
      sendReachChannels();
      return;

    case "browser.connect":
      try {
        const status = await browserSync!.connect();
        send({ type: "browser.status", requestId: cmd.requestId, status });
      } catch {
        // Browser failures already update the integration status. Avoid showing
        // the same error a second time in the page-wide banner.
        send({ type: "browser.status", requestId: cmd.requestId, status: browserSync!.status() });
      }
      return;

    case "mcp.list":
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      return;

    case "mcp.connect": {
      const subjectId = `mcp:${cmd.config.id}`;
      permissionRepo.ensure(subjectId, "mcp.connect", "ask");
      await authorizeCommand(subjectId, "mcp.connect", "mcp.connect", { id: cmd.config.id, name: cmd.config.name, command: cmd.config.command, url: cmd.config.url });
      mcpServerRepo.upsert(cmd.config);
      // The saved configuration is enabled immediately; connecting the transport
      // (especially a first-time npx download) can take much longer.
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      await mcp.disconnect(cmd.config.id);
      let connectError: string | undefined;
      try {
        if (cmd.config.authMode === "oauth" && !mcp.hasHostedToken(cmd.config)) {
          pendingMcpAuthRequests.set(cmd.config.id, cmd.requestId);
          const authorization = await mcp.beginOAuth(cmd.config);
          if (authorization) {
            send({ type: "mcp.oauth.authorization", requestId: cmd.requestId, serverId: cmd.config.id, ...authorization });
            setTimeout(() => {
              if (pendingMcpAuthRequests.get(cmd.config.id) !== cmd.requestId) return;
              pendingMcpAuthRequests.delete(cmd.config.id);
              send({ type: "error", requestId: cmd.requestId, message: "MCP account login timed out" });
            }, 10 * 60_000);
            return;
          }
          pendingMcpAuthRequests.delete(cmd.config.id);
        }
        if (cmd.config.authMode === "github-device" && !mcp.hasAccessToken(cmd.config.id)) {
          pendingMcpAuthRequests.set(cmd.config.id, cmd.requestId);
          const device = await mcp.beginGitHubDeviceAuth(cmd.config);
          send({ type: "mcp.github.device", serverId: cmd.config.id, userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt });
          void device.completion.catch((error) => {
            if (pendingMcpAuthRequests.get(cmd.config.id) !== cmd.requestId) return;
            pendingMcpAuthRequests.delete(cmd.config.id);
            send({ type: "error", requestId: cmd.requestId, message: String(error) });
          });
          return;
        }
        const tools = await mcp.connect(cmd.config);
        await refreshCustomTools();
        send({ type: "mcp.connected", serverId: cmd.config.id, toolCount: tools.length });
      } catch (err) {
        pendingMcpAuthRequests.delete(cmd.config.id);
        connectError = String(err instanceof Error ? err.message : err);
      }
      // 无论成败都推列表：配置已持久化，前端必须立即看到新条目和连接状态，
      // 失败时 connectError 通过 error 事件透出，服务以"未连接"留在列表里。
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      if (connectError) send({ type: "error", requestId: cmd.requestId, message: connectError });
      return;
    }

    case "mcp.delete": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown MCP server ${cmd.serverId}` });
        return;
      }
      await mcp.disconnect(cmd.serverId);
      mcp.clearCredentials(cmd.serverId);
      pendingMcpAuthRequests.delete(cmd.serverId);
      mcpServerRepo.delete(cmd.serverId);
      for (const value of Object.values(config.env ?? {})) {
        if (value.startsWith("$mcp.env:")) runtimeSecrets.delete(value.slice(1));
      }
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
      if (auth) send({ type: "mcp.oauth.authorization", requestId: cmd.requestId, serverId: cmd.serverId, url: auth.url, state: auth.state });
      return;
    }

    case "mcp.oauth.complete": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      await mcp.completeOAuth(config, cmd.code, cmd.state, cmd.iss);
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
        return { id, metadata: resolved.metadata, thinkingLevels: [...thinkingLevelsForApi(cmd.apiType)], sources: resolved.sources };
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
      if (cmd.key === "reach.xueqiu.cookie" || cmd.key === "reach.groq.apiKey") {
        runtimeSecrets.set(cmd.key, cmd.value);
        send({ type: "secret.saved", requestId: cmd.requestId });
        sendReachChannels();
        return;
      }
      if (cmd.key.startsWith("mcp.env:")) {
        runtimeSecrets.set(cmd.key, cmd.value);
        const config = mcpServerRepo.list().find((server) => Object.values(server.env ?? {}).includes(`$${cmd.key}`));
        if (config && permissionRepo.get(`mcp:${config.id}`, "mcp.connect") === "allow") {
          try {
            await mcp.disconnect(config.id);
            const tools = await mcp.connect(config);
            await refreshCustomTools();
            send({ type: "mcp.connected", serverId: config.id, toolCount: tools.length });
          } catch (error) {
            await refreshCustomTools();
            log.warn("MCP API key restore failed", { serverId: config.id, err: String(error) });
          }
          send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
        }
        send({ type: "secret.saved", requestId: cmd.requestId });
        return;
      }
      const mcpSecret = mcpServerRepo.list().find((server) =>
        server.oauth?.tokenSecretKey === cmd.key || `mcp.oauth:${server.id}` === cmd.key ||
        (server.authMode === "oauth" && [`mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`].includes(cmd.key)));
      if (!mcpSecret && cmd.key === "mcp.oauth:mcp-github") {
        mcp.setAccessToken("mcp-github", cmd.value);
        send({ type: "secret.saved", requestId: cmd.requestId });
        return;
      }
      if (mcpSecret) {
        if (mcpSecret.authMode === "oauth" && cmd.key.endsWith(".client")) mcp.restoreHostedCredential(mcpSecret, "client", cmd.value);
        else if (mcpSecret.authMode === "oauth" && cmd.key.endsWith(".tokens")) mcp.restoreHostedCredential(mcpSecret, "tokens", cmd.value);
        else mcp.setAccessToken(mcpSecret.id, cmd.value);
        if (cmd.key !== `mcp.oauth:${mcpSecret.id}.client` && permissionRepo.get(`mcp:${mcpSecret.id}`, "mcp.connect") === "allow") {
          try {
            await mcp.disconnect(mcpSecret.id);
            const tools = await mcp.connect(mcpSecret);
            await refreshCustomTools();
            send({ type: "mcp.connected", serverId: mcpSecret.id, toolCount: tools.length });
            send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
          } catch (error) {
            log.warn("MCP OAuth credential restore failed", { serverId: mcpSecret.id, err: String(error) });
          }
        }
      } else {
        runtimeSecrets.set(cmd.key, cmd.value);
        await adapter.setSecret(cmd.key, cmd.value);
      }
      send({ type: "secret.saved", requestId: cmd.requestId });
      return;
    }

    case "secret.delete":
      runtimeSecrets.delete(cmd.key);
      await adapter.deleteSecret(cmd.key);
      send({ type: "pong", requestId: cmd.requestId });
      if (cmd.key === "reach.xueqiu.cookie" || cmd.key === "reach.groq.apiKey") sendReachChannels();
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
        .then(async () => {
          const cancelled = cancelledRuns.delete(run.id);
          const parts = assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          if (!assistantMessage && !cancelled) throw new Error("AI returned an empty response");
          assistantBuffers.delete(run.id);
          assistantStreamBuffers.delete(run.id);
          assistantPartsByRun.delete(run.id);
          assistantMessageSequenceByRun.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const status = cancelled ? "cancelled" : "completed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status);
          sessionRepo.touch(cmd.sessionId);
          await releaseBrowserSession();
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
        .catch(async (err) => {
          const cancelled = cancelledRuns.delete(run.id);
          const parts = assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          assistantBuffers.delete(run.id);
          assistantStreamBuffers.delete(run.id);
          assistantPartsByRun.delete(run.id);
          assistantMessageSequenceByRun.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const status = cancelled ? "cancelled" : "failed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status, cancelled ? undefined : String(err));
          await releaseBrowserSession();
          emit(cancelled ? "agent.cancelled" : "agent.failed", cancelled
            ? (assistantMessage ? { message: { id: assistantMessage.id, role: assistantMessage.role, content: assistantMessage.content, parts, runId: assistantMessage.runId, createdAt: assistantMessage.createdAt } } : {})
            : { message: String(err) }, cmd.sessionId, run.id);
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
