import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, openDb, SessionRepo, MessageRepo, RunRepo, SkillRepo, TurnRepo, ToolCallRepo } from "@qone/database";
import { ApprovalQueue, decide, withPermission } from "../src/permissions.js";
import { createPiSessionEntries } from "../src/pi-adapter.js";
import { loadPlugins } from "../src/plugin-runtime.js";
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { decodeCommand } from "@qone/protocol";
import { containsSecretConfig } from "../src/secrets.js";
import { Type } from "typebox";

describe("runtime persistence and permissions", () => {
  test("persists sessions, messages and interrupted runs across reopen", () => {
    const dir = path.join(process.cwd(), ".test-data");
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, `persistence-${crypto.randomUUID()}.db`);
    try {
      const first = openDb(dbPath);
      const sessions = new SessionRepo(first);
      const messages = new MessageRepo(first);
      const runs = new RunRepo(first);
      const session = sessions.create("persisted");
      const run = runs.create(session.id);
      runs.setStatus(run.id, "waiting_approval");
      messages.add(session.id, "user", "hello", run.id);

      const second = openDb(dbPath);
      const recovered = new SessionRepo(second).get(session.id);
      expect(recovered?.title).toBe("persisted");
      expect(new MessageRepo(second).listBySession(session.id)).toHaveLength(1);
      new RunRepo(second).markInterrupted();
      expect(new RunRepo(second).listBySession(session.id)[0]?.status).toBe("interrupted");
      closeDb(first);
      closeDb(second);
    } finally {
      // Bun's Windows SQLite handle can keep the file locked until the test
      // worker exits. Files are unique and ignored by git.
    }
  });

  test("allows workspace reads and asks for external or mutating access", () => {
    expect(decide({ toolName: "read", args: { path: "C:/work/app/a.ts" }, workspacePath: "C:/work/app" })).toBe("allow");
    expect(decide({ toolName: "read", args: { path: "C:/other/a.ts" }, workspacePath: "C:/work/app" })).toBe("ask");
    expect(decide({ toolName: "powershell", args: { command: "Get-Process" }, workspacePath: "C:/work/app" })).toBe("ask");
    expect(decide({ toolName: "browser.screenshot", args: { path: "C:/other/capture.png" }, workspacePath: "C:/work/app" })).toBe("ask");
    expect(decide({ toolName: "read", args: { path: "C:/Windows/System32/x" }, workspacePath: "C:/work/app" })).toBe("deny");
    expect(decide({ toolName: "read", args: { path: "D:/Program Files/app/config" }, workspacePath: "C:/work/app" })).toBe("deny");
  });

  test("rebuilds Pi context from product messages", () => {
    const entries = createPiSessionEntries("C:/work/app", [
      { role: "user", content: "检查 build", createdAt: 1000 },
      { role: "assistant", content: "发现脚本错误", createdAt: 2000 },
    ], { api: "openai-completions", provider: "openai", id: "gpt-test" });
    expect(entries).toHaveLength(3);
    expect(entries[1].type).toBe("message");
    expect(entries[2].type).toBe("message");
    if (entries[2].type === "message") {
      expect(entries[2].message.role).toBe("assistant");
    }
  });

  test("persists turns, skills and marks unfinished tool calls on recovery", () => {
    const dir = path.join(process.cwd(), ".test-data");
    mkdirSync(dir, { recursive: true });
    const dbPath = path.join(dir, `history-${crypto.randomUUID()}.db`);
    const db = openDb(dbPath);
    try {
      const sessions = new SessionRepo(db);
      const runs = new RunRepo(db);
      const turns = new TurnRepo(db);
      const tools = new ToolCallRepo(db);
      const skills = new SkillRepo(db);
      const session = sessions.create("history");
      const run = runs.create(session.id);
      const turn = turns.create(run.id);
      tools.start(run.id, "powershell", { command: "Get-Process" });
      skills.upsert({ id: "review", name: "review", path: "C:/skills/review/SKILL.md", description: "Review code" });

      turns.markInterrupted();
      tools.markInterrupted();
      expect(turns.listByRun(run.id)[0]?.status).toBe("interrupted");
      expect(tools.listByRun(run.id)[0]?.status).toBe("cancelled");
      expect(skills.list()[0]?.name).toBe("review");
      expect(turn.id).toBeTruthy();
    } finally {
      closeDb(db);
    }
  });

  test("registers approval before notifying the UI", async () => {
    const queue = new ApprovalQueue();
    let executed = false;
    const tool = withPermission(defineTool({
      name: "write",
      label: "Write",
      description: "write",
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => {
        executed = true;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    }), {
      queue,
      emitApproval: (approvalId) => expect(queue.approve(approvalId)).toBe(true),
    });
    await tool.execute("tool-call", { path: "file.txt" }, undefined, undefined, undefined);
    expect(executed).toBe(true);
  });

  test("applies network denial to semantic browser tools", async () => {
    let executed = false;
    const tool = withPermission(defineTool({
      name: "browser.extract",
      label: "Extract",
      description: "extract",
      parameters: Type.Object({}),
      execute: async () => {
        executed = true;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    }), {
      queue: new ApprovalQueue(),
      emitApproval: () => {},
      rules: { get: (_subjectId, permission) => permission === "network" ? "deny" : "allow" },
    });
    const result = await tool.execute("tool-call", {}, undefined, undefined, undefined) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(executed).toBe(false);
  });

  test("enforces permissions declared by plugin tools", async () => {
    let executed = false;
    const definition = defineTool({
      name: "plugin:demo:echo",
      label: "Echo",
      description: "echo",
      parameters: Type.Object({}),
      execute: async () => {
        executed = true;
        return { content: [{ type: "text" as const, text: "ok" }] };
      },
    }) as ToolDefinition & { qonePermissions?: string[] };
    definition.qonePermissions = ["network"];
    const tool = withPermission(definition, {
      queue: new ApprovalQueue(),
      emitApproval: () => {},
      rules: { get: (_subjectId, permission) => permission === "network" ? "deny" : "allow" },
    });
    const result = await tool.execute("tool-call", {}, undefined, undefined, undefined) as { isError?: boolean };
    expect(result.isError).toBe(true);
    expect(executed).toBe(false);
  });

  test("cancels a pending approval when the run aborts", async () => {
    const queue = new ApprovalQueue();
    const controller = new AbortController();
    const pending = queue.request("approval", "write", {}, controller.signal);
    controller.abort();
    expect(await pending).toBe(false);
    expect(queue.list()).toHaveLength(0);
  });

  test("loads plugin tools, skills, hooks, storage, events and permissions", async () => {
    const root = path.join(process.cwd(), ".test-data", `plugins-${crypto.randomUUID()}`);
    const pluginDir = path.join(root, "demo");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({
      id: "demo", name: "Demo", version: "1.0.0", permissions: ["network"],
    }));
    writeFileSync(path.join(pluginDir, "index.ts"), `
      export default async function setup(ctx) {
        ctx.tools.register({ name: "echo", label: "Echo", description: "echo", parameters: { type: "object", properties: { value: { type: "string" } }, required: ["value"] }, execute: async (_id, params) => ({ content: [{ type: "text", text: params.value }] }) });
        ctx.skills.register({ name: "demo-skill", description: "demo", content: "Use demo." });
        ctx.hooks.register("beforeRun", async () => {});
        ctx.lifecycle.onShutdown(async () => {});
        ctx.events.on("ready", async (value) => ctx.storage.set("event", String(value)));
        await ctx.events.emit("ready", "received");
        await ctx.storage.set("granted", String(await ctx.permissions.request("network")));
      }
    `);
    try {
      const plugins = await loadPlugins(root, { permissionRules: { get: () => "allow" } });
      expect(plugins).toHaveLength(1);
      expect(plugins[0].tools[0]?.name).toBe("plugin:demo:echo");
      expect((plugins[0].tools[0] as { qonePermissions?: string[] })?.qonePermissions).toEqual(["network"]);
      expect(plugins[0].skills[0]?.name).toBe("demo-skill");
      expect(plugins[0].hooks).toHaveLength(1);
      expect(plugins[0].shutdown).toHaveLength(1);
      const storage = JSON.parse(readFileSync(path.join(pluginDir, ".storage", "kv.json"), "utf8"));
      expect(storage).toEqual({ event: "received", granted: "true" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not import plugin code before explicit full-trust approval", async () => {
    const root = path.join(process.cwd(), ".test-data", `plugins-denied-${crypto.randomUUID()}`);
    const pluginDir = path.join(root, "demo");
    const marker = path.join(root, "imported.txt");
    mkdirSync(pluginDir, { recursive: true });
    writeFileSync(path.join(pluginDir, "manifest.json"), JSON.stringify({ id: "demo", name: "Demo", version: "1.0.0" }));
    writeFileSync(path.join(pluginDir, "index.ts"), `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(marker)}, "imported"); export default function setup() {}`);
    try {
      expect(await loadPlugins(root, { permissionRules: { get: () => "ask" } })).toHaveLength(0);
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("recognizes common secret-bearing model config fields and values", () => {
    expect(containsSecretConfig({ headers: { "X-API-Key": "value" } })).toBe(true);
    expect(containsSecretConfig({ auth: { credential: "value" } })).toBe(true);
    expect(containsSecretConfig({ headers: { custom: "Bearer value" } })).toBe(true);
    expect(containsSecretConfig({ baseUrl: "https://example.test" })).toBe(false);
    expect(decodeCommand(JSON.stringify({ type: "secret.set", requestId: "r", key: "model.apiKey:openai", value: "value" }))?.type).toBe("secret.set");
  });

  test("rejects MCP configs without exactly one secure transport", () => {
    const base = { type: "mcp.connect", requestId: "r", config: { id: "m", name: "MCP" } };
    expect(decodeCommand(JSON.stringify(base))).toBeNull();
    expect(decodeCommand(JSON.stringify({ ...base, config: { ...base.config, command: "server", url: "https://example.com" } }))).toBeNull();
    expect(decodeCommand(JSON.stringify({ ...base, config: { ...base.config, url: "http://example.com" } }))).toBeNull();
    expect(decodeCommand(JSON.stringify({ ...base, config: { ...base.config, url: "http://127.0.0.1:3000/mcp" } }))?.type).toBe("mcp.connect");
    expect(decodeCommand(JSON.stringify({ ...base, config: { ...base.config, command: "server" } }))?.type).toBe("mcp.connect");
  });
});
