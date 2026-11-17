import { applyMcpCredential, mcpServerList } from "../mcp-connections";
import path from "node:path";
import { copyFileSync } from "node:fs";
import { qoneSkillsDir } from "@qone/shared";
import { loadSkills } from "@earendil-works/pi-coding-agent";
import { mcpServerIdentity, mcpValueSecretKeys, type ClaudeCodeSyncResult, type RuntimeCommand, type McpServerInfo } from "@qone/protocol";
import type { runtimeCommandServices } from "../index";
import { globalInstructionsDirectory, globalInstructionsPath, readGlobalInstructions, writeGlobalInstructions } from "../global-instructions";
import { claudeInstalled, claudePaths, revisionOf, readOptional } from "./source";
import { readClaudeMcp } from "./mcp";
import { refreshClaudeMcpAuth } from "./mcp-auth";
import { persistClaudeCredentials } from "./credentials";
import { readClaudeSkills, syncedSkills, saveSyncedSkills } from "./skills";

type Services = ReturnType<typeof runtimeCommandServices>;
type Command = Extract<RuntimeCommand, { type: "claude-code.sync" }>;
const activeTargets = new Set<string>();
export async function syncClaudeCode(cmd: Command, services: Services): Promise<ClaudeCodeSyncResult> {
  if (activeTargets.has(cmd.target)) throw new Error("Claude Code sync is already running");
  activeTargets.add(cmd.target);
  try { return await (cmd.remove ? unsynchronize : synchronize)(cmd, services); }
  finally { activeTargets.delete(cmd.target); }
}
async function synchronize(cmd: Command, services: Services): Promise<ClaudeCodeSyncResult> {
  const paths = claudePaths();
  const result: ClaudeCodeSyncResult = { target: cmd.target, status: "ready", revision: "", found: 0, added: 0, updated: 0, skipped: 0, failed: 0, conflicts: [], issues: [] };
  if (!claudeInstalled(paths)) return { ...result, status: "not-installed" };
  const mayApply = (source: unknown, current: unknown) => {
    result.revision = revisionOf([source, current]);
    if (!cmd.apply) return false;
    if (cmd.revision !== result.revision) { result.status = "confirm"; return false; }
    return true;
  };
  if (cmd.target === "prompt") {
    const content = readOptional(path.join(paths.root, "CLAUDE.md"));
    if (content === undefined || !content.trim()) return { ...result, status: "empty" };
    result.found = 1;
    const current = readGlobalInstructions();
    if (current && current !== content) result.conflicts.push("Qone.md");
    if (!mayApply(content, current)) return { ...result, status: result.conflicts.length || cmd.apply ? "confirm" : "ready" };
    if (current === content) result.skipped++;
    else {
      if (current) copyFileSync(globalInstructionsPath(), `${globalInstructionsPath()}.${Date.now()}.bak`);
      writeGlobalInstructions(content);
      if (current) result.updated++; else result.added++;
    }
    await services.adapter.refreshSkills();
    services.send({ type: "global-prompt", requestId: cmd.requestId, content, path: globalInstructionsPath(), directory: globalInstructionsDirectory() });
  } else if (cmd.target === "skills") {
    const own = loadSkills({ cwd: paths.root, agentDir: paths.root, skillPaths: [qoneSkillsDir()], includeDefaults: false }).skills;
    const source = readClaudeSkills(paths, new Set(own.map(skill => skill.name)));
    const previous = syncedSkills();
    Object.assign(result, { found: source.found, issues: source.issues });
    result.failed = source.issues.filter(issue => issue.code === "invalid" || issue.code === "unreadable").length;
    result.skipped = source.issues.length - result.failed;
    if (!mayApply(source.skills, previous)) return result;
    result.added = source.skills.filter(skill => !previous.some(old => old.path === skill.path)).length;
    result.updated = source.skills.filter(skill => previous.some(old => old.path === skill.path && old.signature !== skill.signature)).length;
    result.skipped += source.skills.length - result.added - result.updated;
    result.updated += previous.filter(old => !source.skills.some(skill => skill.path === old.path)).length;
    saveSyncedSkills(source.skills);
    await services.adapter.refreshSkills();
  } else {
    const source = readClaudeMcp(paths);
    const existing = services.mcpServerRepo.list();
    const stamps = services.stateRepo.get<Record<string, string>>("claude-code.mcp") ?? {};
    Object.assign(result, { found: source.found, issues: source.issues });
    result.failed = source.issues.filter(issue => ["invalid", "missing-variable"].includes(issue.code)).length;
    const claimed = new Set<string>();
    const sourceIds = new Set(source.entries.map(entry => entry.config.id));
    const plans = source.entries.map(entry => {
      const available = existing.filter(server => !claimed.has(server.id) && !sourceIds.has(server.id));
      // Same server under another name (e.g. a configured Qone preset) is reused, never duplicated.
      const identity = mcpServerIdentity(entry.config);
      const same = identity ? available.filter(server => mcpServerIdentity(server) === identity) : [];
      const old = existing.find(server => server.id === entry.config.id)
        ?? available.find(server => server.name.toLowerCase() === entry.config.name.toLowerCase())
        ?? (same.length === 1 && source.entries.filter(item => mcpServerIdentity(item.config) === identity).length === 1 ? same[0] : undefined);
      if (old) claimed.add(old.id);
      if (old && old.id !== entry.config.id) result.conflicts.push(old.name);
      return { ...entry, old };
    });
    if (!mayApply(source, existing)) return { ...result, status: result.conflicts.length || cmd.apply ? "confirm" : "ready" };
    for (const entry of plans) {
      const id = entry.old?.id ?? entry.config.id;
      const remap = (value: string) => value.replaceAll(entry.config.id, id);
      const config: McpServerInfo = { ...entry.config, id,
        ...(entry.config.env ? { env: Object.fromEntries(Object.entries(entry.config.env).map(([key, value]) => [key, remap(value)])) } : {}),
        ...(entry.config.headers ? { headers: Object.fromEntries(Object.entries(entry.config.headers).map(([key, value]) => [key, remap(value)])) } : {}),
      };
      const stamp = revisionOf([entry.config, entry.secrets]);
      if (entry.old && stamps[id] === stamp && revisionOf(config) === revisionOf(entry.old) && !source.issues.some(issue => issue.name === entry.config.name && issue.code === "needs-auth")) { result.skipped++; continue; }
      try {
        if (entry.config.url && source.issues.some(issue => issue.name === entry.config.name && issue.code === "needs-auth")) {
          await refreshClaudeMcpAuth(paths, entry.config.name, entry.config.url);
          const refreshed = readClaudeMcp(paths).entries.find(item => item.config.id === entry.config.id);
          if (refreshed?.secrets[`mcp.oauth:${entry.config.id}.tokens`]) {
            entry.secrets = refreshed.secrets;
            result.issues = result.issues.filter(issue => issue.name !== entry.config.name || issue.code !== "needs-auth");
          }
        }
        const values = Object.fromEntries(Object.entries(entry.secrets).map(([key, value]) => [remap(key), value]));
        const keepAuth = entry.old?.url === config.url && Boolean(config.url) && !values[`mcp.oauth:${id}.tokens`] && !Object.keys(config.headers ?? {}).some(key => key.toLowerCase() === "authorization");
        if (keepAuth && entry.old) {
          config.authMode = entry.old.authMode ?? config.authMode;
          config.oauth = entry.old.oauth;
          config.oauthClientId = entry.old.oauthClientId;
        }
        const removeKeys = entry.old ? [...mcpValueSecretKeys(entry.old), ...(!keepAuth ? [entry.old.oauth?.tokenSecretKey ?? `mcp.oauth:${id}`, `mcp.oauth:${id}.client`, `mcp.oauth:${id}.tokens`] : [])] : [];
        await persistClaudeCredentials(services.send, id, values, removeKeys);
        services.mcpConnectionApprovals.delete(id);
        await services.mcp.disconnect(id);
        if (!keepAuth) services.mcp.clearCredentials(id);
        for (const key of removeKeys) services.runtimeSecrets.delete(key);
        services.mcpServerRepo.upsert(config);
        for (const [key, value] of Object.entries(values)) {
          applyMcpCredential(config, key, value, services);
        }
        // Import does not execute third-party commands. Connecting stays a separate user action.
        services.permissionRepo.ensure(`mcp:${id}`, "mcp.connect", "ask");
        stamps[id] = revisionOf([entry.config, entry.secrets]);
        if (entry.old) result.updated++; else result.added++;
      } catch { result.failed++; result.issues.push({ name: config.name, code: "storage" }); }
    }
    services.stateRepo.set("claude-code.mcp", stamps);
    await services.refreshCustomTools();
    services.send({ type: "mcp.list", servers: mcpServerList(services) });
  }
  result.status = "complete";
  if (!result.found && !result.failed && !result.added && !result.updated) result.status = "empty";
  return result;
}

/** Removes only what sync added to Qone; Claude Code's own files are never touched. */
async function unsynchronize(cmd: Command, services: Services): Promise<ClaudeCodeSyncResult> {
  const result: ClaudeCodeSyncResult = { target: cmd.target, status: "complete", revision: "", found: 0, added: 0, updated: 0, skipped: 0, failed: 0, removed: 0, conflicts: [], issues: [] };
  if (cmd.target === "skills") {
    const previous = syncedSkills();
    saveSyncedSkills([]);
    for (const skill of previous) services.skillRepo.delete(skill.name);
    result.removed = previous.length;
    await services.adapter.refreshSkills();
  } else if (cmd.target === "mcp") {
    const stamps = services.stateRepo.get<Record<string, string>>("claude-code.mcp") ?? {};
    // Sync-created ids carry the claude- prefix; stamps also cover existing servers a sync replaced.
    for (const server of services.mcpServerRepo.list().filter(item => item.id in stamps || item.id.startsWith("claude-"))) {
      const keys = [...mcpValueSecretKeys(server), server.oauth?.tokenSecretKey ?? `mcp.oauth:${server.id}`, `mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`];
      try { await persistClaudeCredentials(services.send, server.id, {}, keys); }
      catch { result.failed++; result.issues.push({ name: server.name, code: "storage" }); continue; }
      services.mcpConnectionApprovals.delete(server.id);
      await services.mcp.disconnect(server.id);
      services.mcp.clearCredentials(server.id);
      services.pendingMcpAuthRequests.delete(server.id);
      for (const key of keys) services.runtimeSecrets.delete(key);
      services.mcpServerRepo.delete(server.id);
      delete stamps[server.id];
      result.removed!++;
    }
    services.stateRepo.set("claude-code.mcp", stamps);
    await services.refreshCustomTools();
    services.send({ type: "mcp.list", servers: mcpServerList(services) });
  }
  return result;
}
