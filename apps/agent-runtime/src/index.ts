import { createLogger, EventBus, SequencedEventJournal } from "@qone/shared";
import type { RuntimeCommand, RuntimeEvent, AgentEvent, SessionInfo, WorkspaceInfo, PermissionDecision, WorkspaceFileInfo } from "@qone/protocol";
import { encode, decodeCommand } from "@qone/protocol";
import { openDb, SessionRepo, MessageRepo, RunRepo, TurnRepo, WorkspaceRepo, ToolCallRepo, McpServerRepo, ModelConfigRepo, SettingsRepo, EventRepo, ArtifactRepo, PermissionRepo, PluginRepo, SkillRepo } from "@qone/database";
import { McpManager } from "@qone/mcp";
import { PiAdapter } from "./pi-adapter.js";
import { ApprovalQueue } from "./permissions.js";
import { discoverPlugins, loadPlugins } from "./plugin-runtime.js";
import { closeAllBrowsers, closeBrowser, createBrowserTools } from "./browser-tools.js";
import path from "node:path";
import { existsSync, mkdirSync, statSync, readdirSync } from "node:fs";
import { createResourceLoader } from "./skills.js";
import { containsSecretConfig } from "./secrets.js";

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
const settingsRepo = new SettingsRepo(db);
const eventRepo = new EventRepo(db);
const artifactRepo = new ArtifactRepo(db);
const permissionRepo = new PermissionRepo(db);
const pluginRepo = new PluginRepo(db);
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
  queueEventPersistence(agentEvent);
  send({ type: "agent.event", event: agentEvent });
});
const assistantBuffers = new Map<string, string>();
const toolCallIds = new Map<string, string>();
const cancelledRuns = new Set<string>();
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
  onMessage: (sessionId, runId, role, content) => {
    if (role === "assistant") assistantBuffers.set(runId, (assistantBuffers.get(runId) ?? "") + content);
  },
  onTool: (sessionId, runId, phase, name, args, result, toolCallId) => {
    if (phase === "start") {
      const row = toolCallRepo.start(runId, name, args);
      if (toolCallId) toolCallIds.set(`${runId}:${toolCallId}`, row.id);
    } else if (toolCallId) {
      const id = toolCallIds.get(`${runId}:${toolCallId}`);
      if (id) {
        toolCallRepo.finish(id, result && (result as { isError?: boolean }).isError ? "failed" : "success", result);
        toolCallIds.delete(`${runId}:${toolCallId}`);
      }
      if (phase === "end" && (name === "browser.screenshot" || name === "browser.download")) {
        const input = args as { path?: string } | undefined;
        const content = (result as { content?: Array<{ text?: string }> } | undefined)?.content;
        const text = content?.map((part) => part.text ?? "").join(" ") ?? "";
        const outputPath = input?.path ?? text.match(/(?:saved to|to)\s+(.+)$/i)?.[1]?.trim();
        if (outputPath && existsSync(outputPath)) {
          const size = statSync(outputPath).size;
          const artifactType = name.endsWith("screenshot") ? "screenshot" : "download";
          const extension = path.extname(outputPath).toLowerCase();
          const mimeType = artifactType === "screenshot"
            ? (extension === ".jpg" || extension === ".jpeg" ? "image/jpeg" : "image/png")
            : undefined;
          const artifact = artifactRepo.add({ sessionId, type: artifactType, name: path.basename(outputPath), path: path.resolve(outputPath), mimeType, size });
          emit("artifact.created", artifact, sessionId, runId);
        }
      }
    }
  },
}, permissionRepo, (sessionId) => messageRepo.listBySession(sessionId).map((message) => ({
  role: message.role,
  content: message.content,
  createdAt: message.createdAt,
})));
adapter.setSessionTools(createBrowserTools, closeBrowser);

const appDataPluginsDir = path.join(process.env.APPDATA ?? process.env.HOME ?? process.cwd(), "QoneAgent", "plugins");
const pluginsDir = process.env.QONE_PLUGINS_DIR
  ? path.resolve(process.env.QONE_PLUGINS_DIR)
  : [path.resolve(process.cwd(), "plugins"), path.resolve(process.cwd(), "../../plugins"), appDataPluginsDir]
      .find((candidate) => existsSync(candidate)) ?? appDataPluginsDir;
for (const [permission, decision] of [
  ["filesystem.write", "ask"],
  ["shell.execute", "ask"],
  ["network", "ask"],
  ["clipboard.read", "ask"],
  ["clipboard.write", "ask"],
  ["browser.control", "ask"],
  ["windows.control", "ask"],
  ["secret.read", "ask"],
  ["mcp.connect", "ask"],
  ["tool.execute", "ask"],
] as const) permissionRepo.ensure("builtin", permission, decision);
const discoveredPlugins = await discoverPlugins(pluginsDir);
for (const plugin of discoveredPlugins) {
  pluginRepo.upsert(plugin.manifest);
  permissionRepo.ensure(`plugin:${plugin.manifest.id}`, "plugin.load", "ask");
  permissionRepo.ensure(`plugin:${plugin.manifest.id}`, "tool.execute", "ask");
  for (const permission of plugin.manifest.permissions) permissionRepo.ensure(`plugin:${plugin.manifest.id}`, permission, "ask");
}
let plugins = await loadPlugins(pluginsDir, { permissionRules: permissionRepo, discovered: discoveredPlugins });
adapter.setPluginSkills(plugins.flatMap((plugin) => plugin.skills));
const mcp = new McpManager(async (serverId, token) => {
  const config = mcpServerRepo.list().find((server) => server.id === serverId);
  const key = config?.oauth?.tokenSecretKey ?? `mcp.oauth:${serverId}`;
  runtimeSecrets.set(key, token);
  send({ type: "mcp.oauth.token", requestId: "oauth-callback", serverId, key, accessToken: token });
  if (config) {
    await mcp.disconnect(serverId);
    try {
      const tools = await mcp.connect(config);
      refreshCustomTools();
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
refreshCustomTools();

function refreshCustomTools() {
  adapter.setCustomTools([...plugins.flatMap((plugin) => plugin.tools), ...mcp.tools()]);
}

async function reloadPlugins() {
  for (const plugin of plugins) {
    for (const handler of plugin.shutdown) await Promise.resolve(handler()).catch((error: unknown) => log.warn("plugin shutdown handler failed", { plugin: plugin.manifest.id, err: String(error) }));
  }
  plugins = await loadPlugins(pluginsDir, { permissionRules: permissionRepo, discovered: discoveredPlugins });
  adapter.setPluginSkills(plugins.flatMap((plugin) => plugin.skills));
  refreshCustomTools();
}

function pluginInfos() {
  return discoveredPlugins.map(({ manifest }) => {
    const loaded = plugins.find((plugin) => plugin.manifest.id === manifest.id);
    return {
      id: manifest.id,
      name: manifest.name,
      version: manifest.version,
      description: manifest.description,
      toolCount: loaded?.tools.length ?? 0,
      skillCount: loaded?.skills.length ?? 0,
      loaded: Boolean(loaded),
    };
  });
}

async function runPluginHooks(event: "beforeRun" | "afterRun" | "shutdown", payload: unknown) {
  for (const plugin of plugins) {
    for (const hook of plugin.hooks.filter((item) => item.event === event)) {
      try { await hook.handler(payload); }
      catch (error) { log.warn("plugin hook failed", { plugin: plugin.manifest.id, event, err: String(error) }); }
    }
  }
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
      send({ type: "pong", requestId: cmd.requestId });
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

    case "session.list":
      send({ type: "session.list", sessions: sessionRepo.list().map(toInfo) });
      return;

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
      const { skills } = await createResourceLoader(requestedCwd, plugins.flatMap((plugin) => plugin.skills));
      for (const skill of skills) skillRepo.upsert(skill);
      send({ type: "skills.list", skills });
      return;
    }

    case "plugins.list":
      send({ type: "plugins.list", plugins: pluginInfos() });
      return;

    case "mcp.list":
      send({ type: "mcp.list", servers: mcpServerRepo.list() });
      return;

    case "mcp.connect": {
      const subjectId = `mcp:${cmd.config.id}`;
      permissionRepo.ensure(subjectId, "mcp.connect", "ask");
      await authorizeCommand(subjectId, "mcp.connect", "mcp.connect", { id: cmd.config.id, name: cmd.config.name, command: cmd.config.command, url: cmd.config.url });
      mcpServerRepo.upsert(cmd.config);
      await mcp.disconnect(cmd.config.id);
      const tools = await mcp.connect(cmd.config);
      adapter.setCustomTools([...plugins.flatMap((p) => p.tools), ...mcp.tools()]);
      send({ type: "mcp.connected", serverId: cmd.config.id, toolCount: tools.length });
      send({ type: "mcp.list", servers: mcpServerRepo.list() });
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
      if (cmd.subjectId.startsWith("plugin:") && cmd.permission === "plugin.load") {
        for (const runId of adapter.stopAll()) cancelledRuns.add(runId);
        await reloadPlugins();
        send({ type: "plugins.list", plugins: pluginInfos() });
      }
      return;
    }

    case "model.list":
      send({ type: "model.list", configs: modelConfigRepo.list() });
      return;

    case "model.upsert": {
      if (containsSecretConfig(cmd.config.config)) {
        send({ type: "error", requestId: cmd.requestId, message: "model secrets must be stored in Windows Credential Manager" });
        return;
      }
      const config = modelConfigRepo.upsert(cmd.config);
      send({ type: "model.updated", config });
      return;
    }

    case "model.delete":
      modelConfigRepo.delete(cmd.id);
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
            adapter.setCustomTools([...plugins.flatMap((p) => p.tools), ...mcp.tools()]);
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
      const run = runRepo.create(cmd.sessionId);
      const turn = turnRepo.create(run.id);
      messageRepo.add(cmd.sessionId, "user", cmd.message, run.id);
      emit("agent.started", { runId: run.id }, cmd.sessionId, run.id);
      const workspaceCwd = s.workspaceId ? workspaceRepo.get(s.workspaceId)?.path : undefined;
      if (s.workspaceId && !workspaceCwd) {
        runRepo.finish(run.id, "failed", "session workspace no longer exists");
        turnRepo.finish(turn.id, "failed");
        emit("agent.failed", { message: "session workspace no longer exists" }, cmd.sessionId, run.id);
        send({ type: "error", requestId: cmd.requestId, message: "session workspace no longer exists" });
        return;
      }

      Promise.resolve()
        .then(() => runPluginHooks("beforeRun", { sessionId: cmd.sessionId, runId: run.id, message: cmd.message }))
        .then(() => adapter.run(cmd.sessionId, cmd.message, { model: cmd.model, cwd: workspaceCwd, runId: run.id }, (type, payload) =>
          emit(type, payload, cmd.sessionId, run.id)
        ))
        .then(() => {
          const assistant = assistantBuffers.get(run.id);
          if (assistant?.trim()) messageRepo.addAssistant(cmd.sessionId, assistant, run.id, cmd.model);
          assistantBuffers.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const cancelled = cancelledRuns.delete(run.id);
          const status = cancelled ? "cancelled" : "completed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status);
          sessionRepo.touch(cmd.sessionId);
          void runPluginHooks("afterRun", { sessionId: cmd.sessionId, runId: run.id, status });
          emit(cancelled ? "agent.cancelled" : "agent.completed", {}, cmd.sessionId, run.id);
        })
        .catch((err) => {
          assistantBuffers.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const cancelled = cancelledRuns.delete(run.id);
          const status = cancelled ? "cancelled" : "failed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status, cancelled ? undefined : String(err));
          void runPluginHooks("afterRun", { sessionId: cmd.sessionId, runId: run.id, status, error: String(err) });
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
    if (!cmd) continue;
    handle(cmd).catch((err) => {
      log.error("command failed", { err: String(err) });
      send({ type: "error", requestId: cmd.requestId, message: String(err) });
    });
  }
}

for (const plugin of plugins) {
  for (const handler of plugin.shutdown) {
    try { await handler(); }
    catch (error) { log.warn("plugin shutdown handler failed", { plugin: plugin.manifest.id, err: String(error) }); }
  }
}
await runPluginHooks("shutdown", {});
await mcp.disconnectAll();
await closeAllBrowsers();
for (const session of adapter.getSessions()) {
  try { await session.dispose(); } catch (error) { log.warn("Pi session dispose failed", { err: String(error) }); }
}
flushEvents();
