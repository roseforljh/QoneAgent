import { McpAccountLoginRequiredError } from "@qone/mcp";
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { decodeCommand, mcpServerIdentity, type McpServerInfo, type RuntimeEvent } from "@qone/protocol";
import { ConfigFile, McpServerRepo } from "@qone/database";
import { claudeInstalled, claudePaths } from "../src/claude-code/source";
import { readClaudeMcp, expandClaudeVariable } from "../src/claude-code/mcp";
import { readClaudeSkills, syncedSkills } from "../src/claude-code/skills";
import { syncClaudeCode } from "../src/claude-code/sync";
import { acknowledgeClaudeCredentials } from "../src/claude-code/credentials";
import { handleRuntimeCommand } from "../src/runtime-commands";
import { createResourceLoader, createLocalSkill, deleteLocalSkill } from "../src/skills";
import { claudeMcpToken } from "../src/claude-code/mcp-auth";
import { writeGlobalInstructions, readGlobalInstructions } from "../src/global-instructions";

const previous = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, QONE_DATA_DIR: process.env.QONE_DATA_DIR, PATH: process.env.PATH, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE };
const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-claude-sync-")); roots.push(root);
  process.env.CLAUDE_CONFIG_DIR = path.join(root, "claude");
  process.env.QONE_DATA_DIR = path.join(root, "qone");
  process.env.HOME = process.env.USERPROFILE = root;
  mkdirSync(process.env.CLAUDE_CONFIG_DIR, { recursive: true });
  return { root, claude: process.env.CLAUDE_CONFIG_DIR, qone: process.env.QONE_DATA_DIR };
}
function write(file: string, value: unknown) { mkdirSync(path.dirname(file), { recursive: true }); writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value)); }
function harness(saved = true) {
  const servers = new Map<string, McpServerInfo>();
  const prefs = new Map<string, unknown>();
  const events: RuntimeEvent[] = [];
  const runtimeSecrets = new Map<string, string>();
  let refreshed = 0;
  const services = {
    adapter: { refreshSkills: async () => { refreshed++; } },
    send: (event: RuntimeEvent) => { events.push(event); if (event.type === "claude-code.credentials") acknowledgeClaudeCredentials(event.requestId, saved); }, runtimeSecrets,
    mcpServerRepo: { list: () => [...servers.values()], upsert: (c: McpServerInfo) => servers.set(c.id, c), delete: (id: string) => servers.delete(id) },
    skillRepo: { delete: () => {} }, pendingMcpAuthRequests: new Map(),
    preferencesRepo: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) },
    stateRepo: { get: (key: string) => prefs.get(key), set: (key: string, value: unknown) => prefs.set(key, value) },
    mcp: { disconnect: async () => {}, clearCredentials: () => {}, restoreHostedCredential: () => {}, isConnecting: () => false, isConnected: () => false, toolCount: () => 0 },
    permissionRepo: { ensure: () => {} }, refreshCustomTools: async () => {},
  } as unknown as Parameters<typeof syncClaudeCode>[1];
  const sync = (target: "prompt" | "mcp" | "skills", revision?: string) => syncClaudeCode({ type: "claude-code.sync", requestId: "sync", target, ...(revision !== undefined ? { apply: true, revision } : {}) }, services);
  const unsync = (target: "mcp" | "skills") => syncClaudeCode({ type: "claude-code.sync", requestId: "unsync", target, remove: true }, services);
  return { services, servers, events, runtimeSecrets, sync, unsync, refreshed: () => refreshed };
}
afterEach(() => {
  for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

test("finds configured paths, distinguishes an absent installation, and rejects invalid protocol targets", () => {
  const f = fixture();
  expect(claudePaths().config).toBe(path.join(f.claude, ".claude.json"));
  expect(claudeInstalled(claudePaths())).toBe(true);
  rmSync(f.claude, { recursive: true }); process.env.PATH = "";
  expect(claudeInstalled(claudePaths())).toBe(false);
  expect(decodeCommand(JSON.stringify({ type: "claude-code.sync", requestId: "r", target: "prompt" }))).toMatchObject({ target: "prompt" });
  expect(decodeCommand(JSON.stringify({ type: "claude-code.sync", requestId: "r", target: "account" }))).toBeNull();
});

test("empty installation and no installation produce different sync results", async () => {
  const f = fixture(); const h = harness();
  expect((await h.sync("prompt")).status).toBe("empty");
  for (const target of ["mcp", "skills"] as const) {
    const preview = await h.sync(target);
    expect((await h.sync(target, preview.revision)).status).toBe("empty");
  }
  rmSync(f.claude, { recursive: true }); process.env.PATH = "";
  for (const target of ["prompt", "mcp", "skills"] as const) expect((await h.sync(target)).status).toBe("not-installed");
});

test("prompt preview never writes, confirmed replace backs up, stale confirmations cannot overwrite", async () => {
  const f = fixture(); const h = harness();
  writeGlobalInstructions("my existing instructions");
  write(path.join(f.claude, "CLAUDE.md"), "中文规则\n");
  const preview = await h.sync("prompt");
  expect(preview.status).toBe("confirm"); expect(readGlobalInstructions()).toBe("my existing instructions");
  write(path.join(f.claude, "CLAUDE.md"), "new rules\n");
  expect((await h.sync("prompt", preview.revision)).status).toBe("confirm");
  const confirmed = await h.sync("prompt");
  expect((await h.sync("prompt", confirmed.revision)).updated).toBe(1);
  expect(readGlobalInstructions()).toBe("new rules\n");
  const backups = readdirSync(f.qone).filter(file => file.endsWith(".bak"));
  expect(backups).toHaveLength(1); expect(readFileSync(path.join(f.qone, backups[0]!), "utf8")).toBe("my existing instructions");
  expect(h.refreshed()).toBe(1);
  const repeated = await h.sync("prompt"); expect((await h.sync("prompt", repeated.revision)).skipped).toBe(1);
  expect(readFileSync(path.join(f.claude, "CLAUDE.md"), "utf8")).toBe("new rules\n");
});

test("MCP conversion expands variables, preserves transport/headers, matches OAuth by exact name AND URL", () => {
  const f = fixture();
  write(path.join(f.claude, ".claude.json"), { mcpServers: {
    local: { command: "tool", args: ["--name", "has spaces"], env: { KEY: "secret-one", MODE: "${UNSET:-default}" } },
    remote: { type: "sse", url: "https://example.com/mcp", headers: { "X-Api-Key": "header-secret" } },
    oauth: { type: "http", url: "https://example.com/oauth" },
    missing: { type: "http", url: "${SURELY_MISSING_QONE_TEST}" },
    shadowed: { command: "user-tool" },
  }, projects: { "/other-project": { mcpServers: { ignored: { command: "ignored" } } } } });
  write(path.join(f.claude, ".credentials.json"), { claudeAiOauth: { accessToken: "NEVER_IMPORT_CLAUDE_ACCOUNT" }, mcpOAuth: {
    opaque: { serverName: "oauth", serverUrl: "https://example.com/oauth", accessToken: "valid-mcp-token", refreshToken: "NEVER_IMPORT_REFRESH", expiresAt: Date.now() + 60000 },
    wrong: { serverName: "remote", serverUrl: "https://different.com/mcp", accessToken: "WRONG_TOKEN" },
  } });
  // Claude Code ignores `disabled` and lets the home .mcp.json win on a shared name.
  write(path.join(f.root, ".mcp.json"), { mcpServers: { shadowed: { command: "project-tool", disabled: true }, shared: { command: "npx", args: ["-y", "tool"] } } });
  const source = readClaudeMcp(claudePaths());
  expect(source.found).toBe(6); expect(source.entries).toHaveLength(5);
  expect(source.entries.find(item => item.config.name === "shadowed")?.config.command).toBe("project-tool");
  expect(source.entries.find(item => item.config.name === "shared")?.config.args).toEqual(["-y", "tool"]);
  expect(source.entries[0]!.config.args).toEqual(["--name", "has spaces"]);
  expect(Object.values(source.entries[0]!.secrets)).toContain("default");
  expect(source.entries[1]!.config.transport).toBe("sse");
  expect(source.entries[1]!.config.authMode).toBeUndefined();
  expect(source.entries[2]!.config.authMode).toBe("oauth");
  expect(source.issues).toContainEqual({ name: "missing", code: "missing-variable", detail: "SURELY_MISSING_QONE_TEST" });
  expect(JSON.stringify(source.entries.map(item => item.config))).not.toContain("secret-one");
  expect(JSON.stringify(source)).not.toContain("NEVER_IMPORT_CLAUDE_ACCOUNT");
  expect(JSON.stringify(source)).not.toContain("NEVER_IMPORT_REFRESH");
  expect(JSON.stringify(source)).not.toContain("WRONG_TOKEN");
  expect(expandClaudeVariable("x${A}y${B:-z}", { A: "1" })).toBe("x1yz");
});

test("MCP sync persists references, emits secret-only events, deduplicates and confirms existing configurations", async () => {
  const f = fixture(); const h = harness();
  write(path.join(f.claude, ".claude.json"), { mcpServers: { example: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer SECRET_NO_LEAK" } } } });
  const preview = await h.sync("mcp"); expect(preview.found).toBe(1); expect(h.servers.size).toBe(0);
  const result = await h.sync("mcp", preview.revision);
  expect(result.added).toBe(1); expect(h.servers.size).toBe(1);
  expect(JSON.stringify(result)).not.toContain("SECRET_NO_LEAK");
  expect(JSON.stringify([...h.servers.values()])).not.toContain("SECRET_NO_LEAK");
  expect([...h.runtimeSecrets.values()]).toContain("Bearer SECRET_NO_LEAK");
  expect(h.events.some(event => event.type === "claude-code.credentials")).toBe(true);
  const repeat = await h.sync("mcp"); expect((await h.sync("mcp", repeat.revision)).skipped).toBe(1);
  h.servers.clear(); h.servers.set("custom", { id: "custom", name: "example", url: "https://old.example.com" });
  const conflict = await h.sync("mcp"); expect(conflict.status).toBe("confirm");
  expect(h.servers.get("custom")?.url).toBe("https://old.example.com");
  expect((await h.sync("mcp", conflict.revision)).updated).toBe(1); expect(h.servers.size).toBe(1);
  expect(h.servers.get("custom")?.url).toBe("https://example.com/mcp");
  const file = path.join(f.root, "settings.json");
  const repo = new McpServerRepo(new ConfigFile(file));
  repo.upsert([...h.servers.values()][0]!);
  expect(repo.list()[0]?.transport).toBe("http");
  expect(readFileSync(file, "utf8")).not.toContain("SECRET_NO_LEAK");
});

test("removing synced MCP deletes only synced servers and their stored secrets", async () => {
  const f = fixture(); const h = harness();
  write(path.join(f.root, ".mcp.json"), { mcpServers: { local: { command: "never-run", env: { TOKEN: "secret" } } } });
  h.servers.set("mine", { id: "mine", name: "mine", command: "keep" });
  const preview = await h.sync("mcp"); await h.sync("mcp", preview.revision);
  expect(h.servers.size).toBe(2);
  const removed = await h.unsync("mcp");
  expect(removed).toMatchObject({ removed: 1, failed: 0 }); expect([...h.servers.keys()]).toEqual(["mine"]);
  expect(h.runtimeSecrets.size).toBe(0);
  expect(h.events.filter(event => event.type === "claude-code.credentials").at(-1)).toMatchObject({ values: {} });
});

test("a synced service Qone already has reuses that server instead of duplicating it", async () => {
  const f = fixture(); const h = harness();
  expect(mcpServerIdentity({ command: "npx.cmd", args: ["@upstash/context7-mcp@latest"] })).toBe(mcpServerIdentity({ command: "npx", args: ["-y", "@upstash/context7-mcp"] }));
  expect(mcpServerIdentity({ command: "npx", args: ["-y", "rea-agents"] })).not.toBe(mcpServerIdentity({ command: "npx", args: ["-y", "rea-agents", "mcp"] }));
  write(path.join(f.root, ".mcp.json"), { mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] } } });
  h.servers.set("mcp-context7", { id: "mcp-context7", name: "Context7", command: "npx", args: ["-y", "@upstash/context7-mcp"] });
  const preview = await h.sync("mcp");
  expect(await h.sync("mcp", preview.revision)).toMatchObject({ added: 0, updated: 1 });
  expect([...h.servers.keys()]).toEqual(["mcp-context7"]);  // A script launcher hides the package; the same service name still lands on the existing preset.
  write(path.join(f.root, ".mcp.json"), { mcpServers: { context7: { command: "npx", args: ["-y", "@upstash/context7-mcp@latest"] }, firecrawl: { command: "C:/start-firecrawl.cmd" } } });
  h.servers.set("mcp-firecrawl", { id: "mcp-firecrawl", name: "Firecrawl", command: "npx", args: ["-y", "firecrawl-mcp"] });
  const again = await h.sync("mcp"); await h.sync("mcp", again.revision);
  expect([...h.servers.keys()].sort()).toEqual(["mcp-context7", "mcp-firecrawl"]);
  expect(h.servers.get("mcp-firecrawl")?.command).toBe("C:/start-firecrawl.cmd");
});

test("several MCP names sharing a URL remain distinct across syncs", async () => {
  const f = fixture(); const h = harness();
  write(path.join(f.claude, ".claude.json"), { mcpServers: {
    first: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer first" } },
    second: { type: "http", url: "https://example.com/mcp", headers: { Authorization: "Bearer second" } },
  } });
  h.servers.set("custom", { id: "custom", name: "first", url: "https://example.com/mcp" });
  const preview = await h.sync("mcp");
  const applied = await h.sync("mcp", preview.revision);
  expect(applied).toMatchObject({ added: 1, updated: 1, failed: 0 });
  expect([...h.servers.values()].map(item => item.name)).toEqual(["first", "second"]);
  expect(h.runtimeSecrets.get(Object.values(h.servers.get("custom")!.headers!)[0]!.slice(1))).toBe("Bearer first");
  const repeat = await h.sync("mcp"); expect((await h.sync("mcp", repeat.revision)).skipped).toBe(2);
});

test("syncing a source without usable OAuth preserves Qone's existing account for the same endpoint", async () => {
  const f = fixture(); const h = harness(); let cleared = false;
  write(path.join(f.claude, ".claude.json"), { mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } } });
  h.servers.set("existing", { id: "existing", name: "remote", url: "https://example.com/mcp", authMode: "oauth" });
  h.services.mcp.clearCredentials = () => { cleared = true; };
  const preview = await h.sync("mcp"); await h.sync("mcp", preview.revision);
  expect(cleared).toBe(false); expect(h.servers.get("existing")?.authMode).toBe("oauth");
  const secretEvents = h.events.filter(event => event.type === "claude-code.credentials");
  expect(secretEvents.every(event => !event.removeKeys.some(key => key.startsWith("mcp.oauth:")))).toBe(true);
});

test("failed encrypted storage does not replace configuration or report success", async () => {
  const f = fixture(); const h = harness(false);
  write(path.join(f.claude, ".claude.json"), { mcpServers: { local: { command: "never-run", env: { TOKEN: "test-secret" } } } });
  h.servers.set("custom", { id: "custom", name: "local", command: "keep-original" });
  const preview = await h.sync("mcp");
  const result = await h.sync("mcp", preview.revision);
  expect(result.failed).toBe(1); expect(result.updated).toBe(0);
  expect(result.issues).toContainEqual({ name: "local", code: "storage" });
  expect(h.servers.get("custom")?.command).toBe("keep-original");
  expect(h.runtimeSecrets.size).toBe(0);
});

test("remote imports without a readable OAuth token can be authorized explicitly in Qone", async () => {
  fixture(); const h = harness();
  h.servers.set("remote", { id: "remote", name: "Remote", url: "https://example.com/mcp" });
  h.services.authorizeCommand = async () => {};
  let discovered = false;
  h.services.mcp.connect = async () => { throw new McpAccountLoginRequiredError("Remote"); };
  h.services.mcp.beginOAuth = async config => { discovered = config.authMode === "oauth"; return { url: "https://example.com/authorize", state: "state" }; };
  await handleRuntimeCommand({ type: "mcp.oauth.begin", requestId: "auth", serverId: "remote" }, h.services);
  expect(discovered).toBe(true);
  expect(h.servers.get("remote")?.authMode).toBe("oauth");
  expect(h.events.some(event => event.type === "mcp.oauth.authorization")).toBe(true);
});

test("expired OAuth is reported without copying a token and corrupted JSON never leaks its contents", () => {
  const f = fixture();
  write(path.join(f.claude, ".claude.json"), { mcpServers: { remote: { type: "http", url: "https://example.com/mcp" } } });
  write(path.join(f.claude, ".credentials.json"), { mcpOAuth: { key: { serverName: "remote", serverUrl: "https://example.com/mcp", accessToken: "expired", expiresAt: 1 } } });
  const source = readClaudeMcp(claudePaths());
  expect(source.issues).toContainEqual({ name: "remote", code: "needs-auth" });
  expect(JSON.stringify(source.entries)).not.toContain("expired");
  write(path.join(f.claude, ".claude.json"), '{"secret":"SECRET_IN_BROKEN_JSON"');
  expect(() => readClaudeMcp(claudePaths())).toThrow("Invalid JSON:");
  try { readClaudeMcp(claudePaths()); } catch (error) { expect(String(error)).not.toContain("SECRET_IN_BROKEN_JSON"); }
});

test("skills keep original resources, import enabled plugin paths, preserve built-ins, refresh loader, and remove disabled references", async () => {
  const f = fixture(); const h = harness();
  const skill = (name: string) => `---\nname: ${name}\ndescription: Does useful work\n---\nRead references/guide.md\n`;
  write(path.join(f.claude, "skills", "local", "SKILL.md"), skill("local"));
  write(path.join(f.claude, "skills", "local", "references", "guide.md"), "resource");
  write(path.join(f.claude, "skills", "local", "scripts", "run.sh"), "do not execute");
  write(path.join(f.claude, "skills", "ponytail", "SKILL.md"), skill("ponytail"));
  const plugin = path.join(f.root, "plugin");
  write(path.join(plugin, ".claude-plugin", "plugin.json"), { skills: ["./extras"] });
  write(path.join(plugin, "extras", "plugin-skill", "SKILL.md"), skill("plugin-skill"));
  write(path.join(f.claude, "plugins", "installed_plugins.json"), { version: 2, plugins: { "plugin@test": [{ scope: "user", installPath: plugin }] } });
  write(path.join(f.claude, "settings.json"), { enabledPlugins: { "plugin@test": true } });
  const read = readClaudeSkills(claudePaths(), new Set());
  expect(read.skills.map(item => item.name)).toEqual(["local", "plugin-skill"]);
  expect(read.issues).toContainEqual({ name: "ponytail", code: "builtin" });
  const preview = await h.sync("skills"); expect((await h.sync("skills", preview.revision)).added).toBe(2);
  expect(syncedSkills()).toHaveLength(2);
  expect(existsSync(path.join(f.qone, "skills", "installed", "local"))).toBe(false);
  const loaded = await createResourceLoader(f.root);
  const imported = loaded.skills.find(item => item.name === "local")!;
  expect(imported.path).toBe(path.join(f.claude, "skills", "local", "SKILL.md"));
  expect(readFileSync(path.join(path.dirname(imported.path), "references", "guide.md"), "utf8")).toBe("resource");
  const repeat = await h.sync("skills"); expect((await h.sync("skills", repeat.revision)).added).toBe(0);
  write(path.join(f.claude, "settings.json"), { enabledPlugins: { "plugin@test": false } });
  const disabled = await h.sync("skills"); await h.sync("skills", disabled.revision);
  expect(syncedSkills().map(item => item.name)).toEqual(["local"]);
  rmSync(path.join(f.claude, "skills", "local"), { recursive: true });
  const removed = await h.sync("skills");
  expect((await h.sync("skills", removed.revision)).updated).toBe(1);
  expect(syncedSkills()).toEqual([]);
});

test("removing synced skills unlinks Qone without deleting Claude resources, local installs delete their own files", async () => {
  const f = fixture(); const h = harness();
  const file = path.join(f.claude, "skills", "removable", "SKILL.md");
  write(file, "---\nname: removable\ndescription: test removal\n---\nRead references/guide.md");
  const reference = path.join(path.dirname(file), "references", "guide.md"); write(reference, "keep source");
  const preview = await h.sync("skills"); await h.sync("skills", preview.revision);
  expect((await createResourceLoader(f.root)).skills.some(skill => skill.id === "removable")).toBe(true);
  await deleteLocalSkill("removable");
  expect(syncedSkills()).toEqual([]);
  expect((await createResourceLoader(f.root)).skills.some(skill => skill.id === "removable")).toBe(false);
  expect(readFileSync(reference, "utf8")).toBe("keep source");
  const local = await createLocalSkill("local-delete", "local", "body");
  await deleteLocalSkill(local.id); expect(existsSync(path.dirname(local.path))).toBe(false);
  await expect(deleteLocalSkill("../outside")).rejects.toThrow();
  await expect(deleteLocalSkill("ponytail")).rejects.toThrow();
  const again = await h.sync("skills"); await h.sync("skills", again.revision);
  expect(await h.unsync("skills")).toMatchObject({ removed: 1 });
  expect(syncedSkills()).toEqual([]); expect(readFileSync(file, "utf8")).toContain("name: removable");
});

test("GitHub reconnect uses a stored token instead of starting another device login", async () => {
  fixture(); const h = harness(); let connected = 0; let deviceLogins = 0;
  h.services.authorizeCommand = async () => {};
  h.services.mcp.hasAccessToken = () => true;
  h.services.mcp.connectGitHub = async () => { deviceLogins++; throw new Error("unexpected login"); };
  h.services.mcp.connect = async () => { connected++; return []; };
  await handleRuntimeCommand({ type: "mcp.connect", requestId: "reconnect", config: { id: "github", name: "GitHub", url: "https://api.githubcopilot.com/mcp/", authMode: "github-device", oauthClientId: "client" } }, h.services);
  expect(connected).toBe(1); expect(deviceLogins).toBe(0);
});

test("source token reuse matches name and URL and never exposes refresh credentials", async () => {
  const f = fixture(); process.env.PATH = "";
  write(path.join(f.claude, ".credentials.json"), { mcpOAuth: { key: { serverName: "remote", serverUrl: "https://example.com/mcp", accessToken: "valid", refreshToken: "private-refresh", expiresAt: Date.now() + 60000 } } });
  expect(await claudeMcpToken({ name: "wrong", url: "https://example.com/mcp" })).toBeUndefined();
  const token = await claudeMcpToken({ name: "remote", url: "https://example.com/mcp" });
  expect(JSON.parse(token!)).toMatchObject({ access_token: "valid", qone_claude_source: true });
  expect(token).not.toContain("private-refresh");
});

test("invalid skills are reported, helper markdown is not imported, and Qone skills win name collisions", () => {
  const f = fixture();
  write(path.join(f.claude, "skills", "broken", "SKILL.md"), "---\nname: broken\n---\nmissing description");
  write(path.join(f.claude, "skills", "helper", "README.md"), "---\nname: helper\ndescription: not a declared skill\n---\nhelper");
  write(path.join(f.claude, "skills", "existing", "SKILL.md"), "---\nname: existing\ndescription: collision\n---\nkeep Qone");
  const source = readClaudeSkills(claudePaths(), new Set(["existing"]));
  expect(source.skills).toEqual([]);
  expect(source.found).toBe(2);
  expect(source.issues).toContainEqual({ name: "broken", code: "invalid" });
  expect(source.issues).toContainEqual({ name: "existing", code: "conflict" });
});
