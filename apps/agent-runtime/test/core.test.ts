import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { closeDb, openDb, SessionRepo, MessageRepo, RunRepo, SkillRepo, TurnRepo, ToolCallRepo } from "@qone/database";
import { ApprovalQueue, decide, evaluatePermission, permissionProfile, withPermission } from "../src/permissions.js";
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
    expect(decide({ toolName: "powershell", args: { command: "Get-Content C:/Windows/System32/hosts" }, workspacePath: "C:/work/app" })).toBe("deny");
    expect(decide({ toolName: "powershell", args: { command: "Get-Content $HOME/.ssh/id_rsa" }, workspacePath: "C:/work/app" })).toBe("deny");
  });

  test("maps the three run modes to Codex-style approval and permission profiles", () => {
    expect(permissionProfile("ask")).toEqual({ approval: "on-request", filesystem: "read-only", network: "restricted" });
    expect(permissionProfile("auto")).toEqual({ approval: "unless-trusted", filesystem: "workspace-write", network: "restricted" });
    expect(permissionProfile("full")).toEqual({ approval: "never", filesystem: "full", network: "enabled" });
    expect(evaluatePermission({ toolName: "write", args: { path: "C:/work/app/a.ts" }, workspacePath: "C:/work/app" }, "ask").decision).toBe("ask");
    expect(evaluatePermission({ toolName: "write", args: { path: "C:/work/app/a.ts" }, workspacePath: "C:/work/app" }, "auto").decision).toBe("allow");
    expect(evaluatePermission({ toolName: "read", args: { path: "C:/other/a.ts" }, workspacePath: "C:/work/app" }, "auto").reason).toBe("workspace");
    expect(evaluatePermission({ toolName: "powershell", args: { command: "Get-Process" }, workspacePath: "C:/work/app" }, "full").decision).toBe("allow");
    expect(evaluatePermission({ toolName: "powershell", args: { command: "Get-Content C:/Windows/System32/hosts" }, workspacePath: "C:/work/app" }, "full").decision).toBe("deny");
    const allowShell = { get: (_subject: string, permission: string) => permission === "shell.execute" ? "allow" as const : undefined };
    expect(evaluatePermission({ toolName: "powershell", args: { command: "Get-Process" }, workspacePath: "C:/work/app" }, "ask", allowShell).decision).toBe("allow");
    expect(evaluatePermission({ toolName: "write", args: { path: "C:/other/a.ts" }, workspacePath: "C:/work/app" }, "ask", { get: () => "allow" }).decision).toBe("ask");
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

  test("run modes change approvals while preserving explicit and protected denials", async () => {
    let mode: "ask" | "auto" | "full" = "ask";
    let prompts = 0;
    let executions = 0;
    const queue = new ApprovalQueue();
    const makeTool = (name: string) => withPermission(defineTool({
      name, label: name, description: name,
      parameters: Type.Object({ path: Type.String() }),
      execute: async () => { executions++; return { content: [{ type: "text" as const, text: "ok" }] }; },
    }), {
      queue, workspacePath: "C:/work/app", mode: () => mode,
      rules: { get: (_subject, permission) => permission === "shell.execute" ? "deny" : "ask" },
      emitApproval: (id) => { prompts++; queue.approve(id); },
    });
    const write = makeTool("write");
    await write.execute("one", { path: "C:/work/app/file.ts" }, undefined, undefined, undefined);
    expect(prompts).toBe(1);
    mode = "auto";
    await write.execute("two", { path: "C:/work/app/file.ts" }, undefined, undefined, undefined);
    expect(prompts).toBe(1);
    await write.execute("three", { path: "C:/other/file.ts" }, undefined, undefined, undefined);
    expect(prompts).toBe(2);
    mode = "full";
    await write.execute("four", { path: "C:/other/file.ts" }, undefined, undefined, undefined);
    expect(prompts).toBe(2);
    const protectedResult = await write.execute("five", { path: "C:/Windows/System32/hosts" }, undefined, undefined, undefined) as { isError?: boolean };
    expect(protectedResult.isError).toBe(true);
    const deniedResult = await makeTool("powershell").execute("six", { path: "C:/work/app" }, undefined, undefined, undefined) as { isError?: boolean };
    expect(deniedResult.isError).toBe(true);
    expect(executions).toBe(4);
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

  test("applies auto and full modes to browser, plugin and MCP capabilities", async () => {
    let executions = 0;
    let prompts = 0;
    const queue = new ApprovalQueue();
    const makeTool = (name: string, logicalName = name, declaredPermissions: string[] = []) => {
      const definition = defineTool({
        name,
        label: name,
        description: name,
        parameters: Type.Object({}),
        execute: async () => {
          executions++;
          return { content: [{ type: "text" as const, text: "ok" }] };
        },
      }) as ToolDefinition & { qoneToolName?: string; qonePermissions?: string[] };
      if (logicalName !== name) definition.qoneToolName = logicalName;
      definition.qonePermissions = declaredPermissions;
      return withPermission(definition, {
        queue,
        workspacePath: "C:/work/app",
        mode: () => mode,
        emitApproval: (id) => {
          prompts++;
          queue.approve(id);
        },
      });
    };
    let mode: "ask" | "auto" | "full" = "auto";

    await makeTool("browser.open").execute("open", {}, undefined, undefined, undefined);
    expect(prompts).toBe(0);
    await makeTool("browser.click").execute("click", {}, undefined, undefined, undefined);
    expect(prompts).toBe(1);
    await makeTool("plugin_demo", "plugin:demo:fetch", ["network"]).execute("plugin", {}, undefined, undefined, undefined);
    expect(prompts).toBe(2);
    mode = "full";
    await makeTool("mcp_demo", "mcp:demo:fetch").execute("mcp", {}, undefined, undefined, undefined);
    expect(prompts).toBe(2);
    expect(executions).toBe(4);
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

  test("accepts only supported run settings in the command protocol", () => {
    const command = { type: "agent.run", requestId: "r", sessionId: "s", message: "hello", permissionMode: "auto", thinking: "xhigh" };
    expect(decodeCommand(JSON.stringify(command))).toMatchObject(command);
    expect(decodeCommand(JSON.stringify({ ...command, permissionMode: "unrestricted" }))).toBeNull();
    expect(decodeCommand(JSON.stringify({ ...command, thinking: "extreme" }))).toBeNull();
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
