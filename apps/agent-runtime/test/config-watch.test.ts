import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { ConfigFile, McpServerRepo, ModelConfigRepo, PermissionRepo, PreferencesRepo } from "@qone/database";
import type { McpServerInfo, RuntimeEvent } from "@qone/protocol";
import { applySettingsChange } from "../src/config-watch";
import { acknowledgeClaudeCredentials } from "../src/claude-code/credentials";
import { validateSettings } from "../src/config-validation";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function harness() {
  const root = mkdtempSync(path.join(tmpdir(), "qone-config-watch-")); roots.push(root);
  const settings = new ConfigFile(path.join(root, "settings.json"), validateSettings);
  const events: RuntimeEvent[] = [], connected: McpServerInfo[] = [], disconnected: string[] = [];
  const runtimeSecrets = new Map<string, string>();
  let broadcasts = 0, skillRefreshes = 0, models: unknown[] = [];
  const services = {
    settingsFile: settings, mcpServerRepo: new McpServerRepo(settings), modelConfigRepo: new ModelConfigRepo(settings),
    permissionRepo: new PermissionRepo(settings), preferencesRepo: new PreferencesRepo(settings), runtimeSecrets, pendingMcpAuthRequests: new Map(),
    send: (event: RuntimeEvent) => { events.push(event); if (event.type === "claude-code.credentials") acknowledgeClaudeCredentials(event.requestId, true); },
    mcp: {
      connect: async (config: McpServerInfo) => { connected.push(config); return []; }, disconnect: async (id: string) => { disconnected.push(id); },
      clearCredentials: () => {}, invalidateConnection: () => {}, isConnecting: () => false, isConnected: () => false, toolCount: () => 0, hasHostedToken: () => true, hasAccessToken: () => true,
    },
    authorizeCommand: async () => {}, refreshCustomTools: async () => {},
    adapter: { configureModels: async (list: unknown[]) => { models = list; }, refreshSkills: async () => { skillRefreshes++; }, invalidateSessions: async () => {}, setCompactionPreferences: () => {} },
    servers: { broadcast: () => { broadcasts++; }, pool: { drop: () => {} }, sessions: { closeServer: () => {} } }, sendSubagentConfig: () => {}, subagentConfig: undefined as unknown,
    log: { warn: () => {} }, workspaceRepo: { list: () => [] }, skillRepo: { upsert: () => {} },
  };
  // Mirrors the runtime: an external save is diffed against what was there before.
  const edit = async (mutate: (data: Record<string, any>) => void) => {
    const previous = settings.snapshot();
    const next = JSON.parse(readFileSync(settings.file, "utf8")); mutate(next);
    writeFileSync(settings.file, JSON.stringify(next, null, 2));
    settings.reload();
    if (!settings.error) await applySettingsChange(previous, settings.snapshot(), services as never);
    await new Promise(resolve => setTimeout(resolve, 10));
  };
  settings.onInvalid(error => services.send({ type: "error", message: error.message }));
  settings.write("mcpServers", {});
  return { settings, services, events, connected, disconnected, runtimeSecrets, edit, broadcasts: () => broadcasts, skillRefreshes: () => skillRefreshes, models: () => models };
}

test("an agent adding an MCP service to settings.json connects it with its key moved to encrypted storage", async () => {
  const h = harness();
  await h.edit(data => { data.mcpServers.exa = { name: "Exa", command: "npx", args: ["-y", "exa-mcp-server"], env: { EXA_API_KEY: "plain-key", MODE: "$mcp.env:exa/MODE" } }; });
  expect(h.connected).toHaveLength(1);
  expect(h.connected[0]).toMatchObject({ id: "exa", command: "npx", env: { EXA_API_KEY: "$mcp.env:exa/EXA_API_KEY", MODE: "$mcp.env:exa/MODE" } });
  expect(h.runtimeSecrets.get("mcp.env:exa/EXA_API_KEY")).toBe("plain-key");
  expect(h.events.find(event => event.type === "claude-code.credentials")).toMatchObject({ values: { "mcp.env:exa/EXA_API_KEY": "plain-key" } });
  expect(readFileSync(h.settings.file, "utf8")).not.toContain("plain-key");
  expect(h.services.permissionRepo.get("mcp:exa", "mcp.connect")).toBe("allow");
  expect(h.events.some(event => event.type === "mcp.list")).toBe(true);

  await h.edit(data => { data.mcpServers.exa.disabled = true; });
  expect(h.disconnected).toContain("exa"); expect(h.connected).toHaveLength(1);
  await h.edit(data => { delete data.mcpServers.exa.disabled; });
  expect(h.connected).toHaveLength(2);
  await h.edit(data => { delete data.mcpServers.exa; });
  expect(h.services.mcpServerRepo.list()).toEqual([]);
  expect(h.runtimeSecrets.has("mcp.env:exa/EXA_API_KEY")).toBe(false);
  expect(h.events.filter(event => event.type === "claude-code.credentials").at(-1)).toMatchObject({ removeKeys: expect.arrayContaining(["mcp.env:exa/EXA_API_KEY"]) });
});

test("an invalid entry is reported, other sections reload their consumers", async () => {
  const h = harness();
  await h.edit(data => { data.mcpServers.bad = { name: "Bad" }; });
  expect(h.connected).toHaveLength(0);
  expect(h.events.some(event => event.type === "error" && event.message.includes('"bad"'))).toBe(true);
  await h.edit(data => { delete data.mcpServers.bad; data.models = { "p/m": { provider: "p", model: "m", baseUrl: "https://p.dev" } }; });
  expect(h.models()).toHaveLength(1);
  expect(h.events.some(event => event.type === "model.list")).toBe(true);
  await h.edit(data => { data.models["p/m"].apiKey = "sk-leak"; });
  expect(h.events.some(event => event.type === "error" && event.message.includes("API keys"))).toBe(true);
  await h.edit(data => { delete data.models["p/m"].apiKey; data.preferences = { "servers.list": [], "skills.builtin.ponytail": { enabled: false } }; });
  expect(h.broadcasts()).toBe(1); expect(h.skillRefreshes()).toBe(1);
});

test("saved server authentication validates from auth rather than add-command credentials", () => {
  const server = { id: "saved", name: "Saved", host: "example.com", port: 22, username: "user" };
  const validate = (auth: unknown) => validateSettings({ preferences: { "servers.list": [{ ...server, auth }] } });
  expect(() => validate({ kind: "key", keyPath: "C:/keys/server", dedicated: true })).not.toThrow();
  expect(() => validate({ kind: "agent" })).not.toThrow();
  expect(() => validate({ kind: "key", dedicated: true })).toThrow("invalid server");
  expect(() => validate({ kind: "password", password: "not-stored" })).toThrow("invalid server");
});
