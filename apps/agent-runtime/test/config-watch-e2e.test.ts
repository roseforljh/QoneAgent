import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

test("external atomic saves reload MCP, models, permissions, parameters, skills and Qone.md without restarting", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-watch-e2e-"));
  const data = path.join(root, "qone");
  const settings = path.join(data, "settings.json");
  const credentials = new Map<string, string>();
  let handshakes = 0, apiKey = "watch-test-secret";
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (request.headers.get("x-api-key") !== apiKey) return new Response(null, { status: 401 });
    const message = await request.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "initialize") handshakes++;
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }
      : { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  } });
  const start = () => Bun.spawn([process.execPath, path.resolve(import.meta.dir, "../src/index.ts")], {
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, QONE_DATA_DIR: data, QONE_DB: path.join(data, "runtime", "qone.db"), QONE_LOG_DIR: path.join(data, "logs"), QONE_MCP_SERVERS: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let child = start();
  let events: RuntimeEvent[] = [];
  const send = (command: RuntimeCommand) => child.stdin.write(`${JSON.stringify(command)}\n`);
  const collect = (process: typeof child) => (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of process.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) {
        const decoded = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
        for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
          if (event.type === "claude-code.credentials") {
            for (const key of event.removeKeys) credentials.delete(key);
            for (const [key, value] of Object.entries(event.values)) credentials.set(key, value);
            process.stdin.write(`${JSON.stringify({ type: "claude-code.credentials.saved", requestId: event.requestId, saved: true })}\n`);
          } else if (event.type === "mcp.credentials.request") {
            process.stdin.write(`${JSON.stringify({ type: "mcp.credentials.restored", requestId: event.requestId, ok: true, values: Object.fromEntries(event.keys.filter(key => credentials.has(key)).map(key => [key, credentials.get(key)])) })}
`);
          } else events.push(event);
        }
      }
    }
  })();
  let collecting = collect(child);
  const wait = async (predicate: (event: RuntimeEvent) => boolean, from = 0) => {
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const event = events.slice(from).find(predicate);
      if (event) return event;
      if (child.exitCode !== null) throw new Error(`Sidecar exited: ${await new Response(child.stderr).text()}`);
      await Bun.sleep(15);
    }
    throw new Error(`Missing live event; recent events: ${JSON.stringify(events.slice(-5))}`);
  };
  const edit = (mutate: (config: Record<string, any>) => void) => {
    const next = JSON.parse(readFileSync(settings, "utf8")); mutate(next);
    const temporary = `${settings}.edit`;
    writeFileSync(temporary, JSON.stringify(next, null, 2)); renameSync(temporary, settings);
    return events.length;
  };
  const request = async (command: RuntimeCommand, type: RuntimeEvent["type"]) => {
    const from = events.length; send(command); return wait(event => event.type === type, from);
  };
  const stop = async () => { child.kill(); await child.exited; await collecting; };
  const available = (id: string) => (event: RuntimeEvent) => event.type === "mcp.list" && event.servers.some(item => item.id === id && item.available && !item.connecting);
  try {
    await request({ type: "ping", requestId: "ready" }, "pong");
    let from = edit(config => { config.mcpServers.fixture = { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: { "X-Api-Key": "watch-test-secret" } }; });
    await wait(available("fixture"), from);
    expect(handshakes).toBe(1);
    expect(readFileSync(settings, "utf8")).not.toContain("watch-test-secret");
    expect(credentials.get("mcp.env:fixture/header-x-api-key")).toBe("watch-test-secret");
    expect(JSON.stringify(events)).not.toContain("watch-test-secret");

    from = edit(config => { config.mcpServers.fixture.disabled = true; });
    await wait(event => event.type === "mcp.list" && event.servers.some(item => item.id === "fixture" && item.disabled && !item.connected), from);
    // Native credential restore must not revive a disabled service.
    await request({ type: "secret.set", requestId: "restore-disabled", key: "mcp.env:fixture/header-x-api-key", value: "watch-test-secret" }, "secret.saved");
    expect(handshakes).toBe(1);
    from = edit(config => { delete config.mcpServers.fixture.disabled; });
    await wait(available("fixture"), from);
    expect(handshakes).toBe(2);

    // Normalizing a changed key produces the same reference; the live transport must still reconnect.
    apiKey = "watch-updated-secret";
    from = edit(config => { config.mcpServers.fixture.headers["X-Api-Key"] = apiKey; });
    await wait(available("fixture"), from);
    expect(handshakes).toBe(3);
    expect(credentials.get("mcp.env:fixture/header-x-api-key")).toBe(apiKey);
    expect(readFileSync(settings, "utf8")).not.toContain(apiKey);
    expect(JSON.stringify(events)).not.toContain(apiKey);
    apiKey = "watch-test-secret";
    from = edit(config => { config.mcpServers.fixture.headers["X-Api-Key"] = apiKey; });
    await wait(available("fixture"), from);
    expect(handshakes).toBe(4);

    from = edit(config => {
      config.models["local/example"] = { provider: "local", model: "example", apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, autoMetadata: false };
      config.permissions.builtin["shell.execute"] = "deny";
      config.preferences["compaction.settings"] = { autoCompactionEnabled: false, compactionThreshold: 75 };
      config.preferences["subagents.config"] = { runtime: { maxConcurrent: 3 } };
      config.preferences["memory.enabled"] = true;
      config.preferences["memory.model"] = "local/example";
    });
    await wait(event => event.type === "model.list" && event.configs.some(item => item.id === "local/example"), from);
    await wait(event => event.type === "permission.list" && event.rules.some(rule => rule.permission === "shell.execute" && rule.decision === "deny"), from);
    await wait(event => event.type === "pong" && event.compaction?.compactionThreshold === 75 && !event.compaction.autoCompactionEnabled, from);
    await wait(event => event.type === "subagent.list" && event.config.runtime.maxConcurrent === 3, from);
    await wait(event => event.type === "memory.state" && event.state.enabled && event.state.modelId === "local/example", from);

    const skill = path.join(data, "skills", "installed", "live-skill", "SKILL.md");
    mkdirSync(path.dirname(skill), { recursive: true });
    from = events.length;
    writeFileSync(skill, "---\nname: live-skill\ndescription: live folder install\n---\nUse this new skill.");
    await wait(event => event.type === "skills.list" && event.skills.some(item => item.name === "live-skill"), from);
    from = events.length; rmSync(path.dirname(skill), { recursive: true });
    await wait(event => event.type === "skills.list" && !event.skills.some(item => item.name === "live-skill"), from);
    from = events.length; writeFileSync(path.join(data, "Qone.md"), "Live global instruction");
    await wait(event => event.type === "global-prompt" && event.content === "Live global instruction", from);

    const good = readFileSync(settings, "utf8");
    from = events.length; writeFileSync(settings, "");
    await wait(event => event.type === "error" && event.message.includes("settings.json"), from);
    const retained = await request({ type: "model.list", requestId: "retained" }, "model.list");
    expect(retained.type === "model.list" && retained.configs.some(item => item.id === "local/example")).toBe(true);
    writeFileSync(settings, good);
    from = edit(config => { delete config.mcpServers.fixture; });
    await wait(event => event.type === "mcp.list" && event.servers.length === 0, from);
    expect(credentials.size).toBe(0);
    expect(existsSync(path.join(data, "config", "settings.db"))).toBe(false);
    expect(existsSync(path.join(data, "mcp", "servers.db"))).toBe(false);

    edit(config => { config.mcpServers.startup = { type: "http", url: `http://127.0.0.1:${server.port}/mcp`, headers: { "X-Api-Key": "watch-test-secret" } }; });
    await stop(); events = [];
    child = start(); collecting = collect(child);
    await wait(available("startup"));
    expect(readFileSync(settings, "utf8")).not.toContain("watch-test-secret");
    const restored = await request({ type: "model.list", requestId: "restarted" }, "model.list");
    expect(restored.type === "model.list" && restored.configs.some(item => item.id === "local/example")).toBe(true);
    const prompt = await request({ type: "global-prompt.get", requestId: "prompt" }, "global-prompt");
    expect(prompt.type === "global-prompt" && prompt.content).toBe("Live global instruction");
    const repaired = JSON.parse(readFileSync(settings, "utf8"));
    delete repaired.mcpServers.startup;
    await stop(); events = [];
    writeFileSync(settings, "{");
    child = start(); collecting = collect(child);
    await request({ type: "ping", requestId: "bad-file-startup" }, "pong");
    expect(readFileSync(settings, "utf8")).toBe("{");
    from = events.length;
    writeFileSync(settings, JSON.stringify(repaired));
    await wait(event => event.type === "model.list" && event.configs.some(item => item.id === "local/example"), from);
  } finally {
    await stop(); server.stop(true);
    rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 });
  }
}, 25_000);
