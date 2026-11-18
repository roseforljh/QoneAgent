import { registerMcp, mcpServerList } from "./mcp-connections";
import { watch } from "node:fs";
import path from "node:path";
import { mcpServersFrom, type ConfigFile } from "@qone/database";
import { decodeCommand, mcpValueSecretKeys, type McpServerInfo, type RuntimeCommand } from "@qone/protocol";
import { qoneSkillsDir } from "@qone/shared";
import type { runtimeCommandServices } from "./index";
import { handleRuntimeCommand } from "./runtime-commands";
import { persistClaudeCredentials } from "./claude-code/credentials";
import { normalizeSubagentConfig } from "./subagents";
import { normalizePiCompactionPreferences } from "./pi-compaction";
import { syncPonytailProject } from "./builtin-skills/manager";
import { globalInstructionsDirectory, globalInstructionsPath, readGlobalInstructions } from "./global-instructions";

type Services = ReturnType<typeof runtimeCommandServices>;
type Json = Record<string, unknown>;
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const section = (data: Json, key: string) => (data[key] && typeof data[key] === "object" ? data[key] : {}) as Json;
const run = (command: RuntimeCommand, services: Services) => handleRuntimeCommand(command, services)
  .catch(error => services.send({ type: "error", requestId: command.requestId, message: error instanceof Error ? error.message : String(error) }));

/** Also used at startup: plaintext keys are encrypted before a service can connect or reach the UI. */
export async function prepareMcpConfiguration(server: McpServerInfo, services: Services): Promise<McpServerInfo | undefined> {
  const values: Record<string, string> = {};
  const reference = (map: Record<string, string> | undefined, prefix: string) => map && Object.fromEntries(Object.entries(map).map(([key, value]) => {
    if (value.startsWith("$mcp.env:") || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value)) return [key, value];
    const secret = `mcp.env:${server.id}/${prefix}${prefix ? key.toLowerCase().replace(/[^a-z0-9]+/g, "-") : key}`;
    values[secret] = value;
    return [key, `$${secret}`];
  }));
  const config = { ...server, ...(server.env ? { env: reference(server.env, "") } : {}), ...(server.headers ? { headers: reference(server.headers, "header-") } : {}) };
  if (Object.keys(values).length) {
    await persistClaudeCredentials(services.send, server.id, values, []);
    services.settingsFile.reload();
    // A newer external edit wins over a credential acknowledgement for an older edit.
    const current = mcpServersFrom(services.settingsFile.read("mcpServers")).find(item => item.id === server.id);
    if (!same(current, server) || services.settingsFile.error) return;
    services.mcpServerRepo.upsert(config);
    if (Object.entries(values).some(([key, value]) => services.runtimeSecrets.get(key) !== value)) services.mcp.invalidateConnection(server.id);
    for (const [key, value] of Object.entries(values)) services.runtimeSecrets.set(key, value);
  }
  services.settingsFile.reload();
  const current = mcpServersFrom(services.settingsFile.read("mcpServers")).find(item => item.id === server.id);
  if (services.settingsFile.error || (!Object.keys(values).length && !same(current, server))) return;
  return config;
}

async function applyMcp(previous: Json, next: Json, services: Services) {
  const before = new Map(mcpServersFrom(previous.mcpServers).map(server => [server.id, server]));
  const after = mcpServersFrom(next.mcpServers);
  for (const [id, old] of before) {
    if (after.some(server => server.id === id) || mcpServersFrom(services.settingsFile.read("mcpServers")).some(server => server.id === id)) continue;
    const keys = [...mcpValueSecretKeys(old), old.oauth?.tokenSecretKey ?? `mcp.oauth:${id}`, `mcp.oauth:${id}.client`, `mcp.oauth:${id}.tokens`];
    services.mcpConnectionApprovals.delete(id);
    await services.mcp.disconnect(id);
    services.mcp.clearCredentials(id);
    services.pendingMcpAuthRequests.delete(id);
    await persistClaudeCredentials(services.send, id, {}, keys);
    for (const key of keys) services.runtimeSecrets.delete(key);
  }
  for (const server of after) {
    if (same(before.get(server.id), server)) continue;
    services.mcpConnectionApprovals.delete(server.id);
    const validated = decodeCommand(JSON.stringify({ type: "mcp.connect", requestId: crypto.randomUUID(), config: server }));
    if (validated?.type !== "mcp.connect") {
      services.send({ type: "error", message: `settings.json: MCP service ${JSON.stringify(server.id)} is not a valid configuration` });
      continue;
    }
    const config = await prepareMcpConfiguration(server, services);
    if (!config) continue;
    if (server.disabled) {
      services.pendingMcpAuthRequests.delete(server.id);
      await services.mcp.disconnect(server.id);
      continue;
    }
    // Installing in the user's configuration grants startup consent, but never overrides an explicit denial.
    services.permissionRepo.ensure(`mcp:${server.id}`, "mcp.connect", "allow");
    if (services.permissionRepo.get(`mcp:${server.id}`, "mcp.connect") === "allow") {
      void registerMcp(config, services).catch(error => services.log.warn("MCP configuration registration failed", { serverId: server.id, err: String(error) }));
    } else services.mcp.register(config);
  }
  await services.refreshCustomTools();
  services.send({ type: "mcp.list", servers: mcpServerList(services) });
}

/** Applies an edit made by the user or agent through the existing runtime paths. */
export async function applySettingsChange(previous: Json, next: Json, services: Services) {
  if (!same(previous.mcpServers, next.mcpServers)) await applyMcp(previous, next, services);
  if (!same(previous.models, next.models)) {
    const configs = services.modelConfigRepo.list();
    await services.adapter.configureModels(configs);
    services.send({ type: "model.list", configs });
  }
  if (!same(previous.permissions, next.permissions)) {
    services.mcpConnectionApprovals.clear();
    await services.refreshCustomTools();
    services.send({ type: "mcp.list", servers: mcpServerList(services) });
    void run({ type: "permission.list", requestId: crypto.randomUUID() }, services);
  }
  const before = section(previous, "preferences"), after = section(next, "preferences");
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter(key => !same(before[key], after[key]));
  if (changed.includes("subagents.config")) {
    services.subagentConfig = normalizeSubagentConfig(after["subagents.config"]);
    services.sendSubagentConfig();
  }
  if (changed.includes("compaction.settings")) {
    const compaction = services.adapter.setCompactionPreferences(normalizePiCompactionPreferences(after["compaction.settings"]));
    services.send({ type: "pong", requestId: crypto.randomUUID(), compaction });
  }
  if (changed.includes("memory.enabled")) {
    if (services.memory.store.setEnabled(after["memory.enabled"] === true)) await services.adapter.invalidateSessions();
    services.send({ type: "memory.state", state: services.memory.store.state() });
  }
  if (changed.includes("servers.list")) {
    const old = before["servers.list"] as { id: string }[] | undefined;
    const current = (after["servers.list"] ?? []) as { id: string }[];
    for (const server of old ?? []) if (!same(server, current.find(item => item.id === server.id))) {
      services.servers.pool.drop(server.id);
      services.servers.sessions.closeServer(server.id);
    }
  }
  if (changed.some(key => key.startsWith("servers."))) {
    services.servers.broadcast();
    await services.adapter.invalidateSessions();
  }
  if (changed.some(key => key.startsWith("skills."))) {
    if (changed.includes("skills.builtin.ponytail")) await Promise.all(services.workspaceRepo.list().map(workspace => syncPonytailProject(workspace.path)));
    await services.adapter.refreshSkills();
    void run({ type: "skills.list", requestId: crypto.randomUUID() }, services);
  }
}

/** Directory watchers also see editors' atomic rename-on-save operations. */
export function watchConfiguration(settings: ConfigFile, services: () => Services) {
  let pending = Promise.resolve();
  const off = settings.onExternalChange((previous, next) => {
    pending = pending.then(() => applySettingsChange(previous, next, services())).catch(error => {
      services().send({ type: "error", message: `settings.json: ${error instanceof Error ? error.message : String(error)}` });
    });
  });
  const invalid = settings.onInvalid(error => services().send({ type: "error", message: `settings.json: ${error.message}` }));
  settings.watch();

  const timers = new Set<ReturnType<typeof setTimeout>>();
  const debounce = (action: () => Promise<void>) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    return () => {
      if (timer) { clearTimeout(timer); timers.delete(timer); }
      timer = setTimeout(() => {
        timers.delete(timer!);
        void action().catch(error => services().log.warn("configuration reload failed", { err: String(error) }));
      }, 400);
      timers.add(timer);
    };
  };
  const watchDirectory = (directory: string, recursive: boolean, listener: (_event: string, name: string | Buffer | null) => void) => {
    const report = (error: unknown) => services().log.warn("configuration watcher failed", { directory, err: String(error) });
    try {
      const watcher = watch(directory, { recursive }, listener);
      return watcher.on("error", (error) => { watcher.close(); report(error); });
    } catch (error) { report(error); }
  };
  const skillsDir = qoneSkillsDir();
  const reloadSkills = debounce(async () => {
    await services().adapter.refreshSkills();
    await run({ type: "skills.list", requestId: crypto.randomUUID() }, services());
  });
  // Watching installed/ itself loses new files when it is replaced and can
  // produce a stream of rename events when the watched root is removed on Windows.
  const skills = watchDirectory(path.dirname(skillsDir), true, (_event, name) => {
    if (!name || path.normalize(String(name)).split(path.sep, 1)[0] === path.basename(skillsDir)) reloadSkills();
  });
  let instructions = readGlobalInstructions();
  const reloadInstructions = debounce(async () => {
    const content = readGlobalInstructions();
    if (content === instructions) return;
    instructions = content;
    await services().adapter.refreshSkills();
    services().send({ type: "global-prompt", requestId: crypto.randomUUID(), content, path: globalInstructionsPath(), directory: globalInstructionsDirectory() });
  });
  const prompt = watchDirectory(path.dirname(globalInstructionsPath()), false, (_event, name) => {
    if (name && path.basename(String(name)) === path.basename(globalInstructionsPath())) reloadInstructions();
  });
  return () => { off(); invalid(); settings.close(); skills?.close(); prompt?.close(); for (const timer of timers) clearTimeout(timer); };
}
