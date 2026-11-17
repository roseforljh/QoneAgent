import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

test("cold startup discovers tools once, restores credentials before OAuth and reuses catalogs after restart", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-mcp-startup-")), data = path.join(root, "qone");
  mkdirSync(data);
  const handshakes = new Map<string, number>();
  let toolCalls = 0;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method !== "POST") return new Response(null, { status: 405 });
    if (new URL(request.url).pathname === "/v1/chat/completions") {
      const body = await request.json() as { tools?: { function: { name: string } }[]; messages: { role: string }[] };
      const finished = body.messages.some(message => message.role === "tool");
      const name = body.tools?.find(tool => tool.function.name.endsWith("_echo"))?.function.name;
      const delta = finished ? { content: "lazy tool completed" } : { tool_calls: [{ index: 0, id: "local-call", type: "function", function: { name, arguments: "{}" } }] };
      return new Response(`data: ${JSON.stringify({ id: "local", object: "chat.completion.chunk", created: 1, model: "test", choices: [{ index: 0, delta, finish_reason: finished ? "stop" : "tool_calls" }] })}

data: [DONE]

`, { headers: { "Content-Type": "text/event-stream" } });
    }
    const id = new URL(request.url).pathname.slice(1);
    if (id !== "fast" && (request.headers.get("x-one") !== "one" || request.headers.get("x-two") !== "two")) return new Response(null, { status: 403 });
    if (id === "account" && request.headers.get("authorization") !== "Bearer account-saved") return new Response(null, { status: 403 });
    const message = await request.json() as { id?: number; method: string };
    if (message.id === undefined) return new Response(null, { status: 202 });
    if (message.method === "tools/call") {
      toolCalls++;
      return Response.json({ jsonrpc: "2.0", id: message.id, result: { content: [{ type: "text", text: "echo from lazy MCP" }] } });
    }
    if (message.method === "initialize") handshakes.set(id, (handshakes.get(id) ?? 0) + 1);
    return Response.json({ jsonrpc: "2.0", id: message.id, result: message.method === "initialize"
      ? { protocolVersion: "2024-11-05", capabilities: { tools: {} }, serverInfo: { name: id, version: "1" } }
      : { tools: [{ name: "echo", inputSchema: { type: "object" } }] } });
  } });
  const url = (id: string) => `http://127.0.0.1:${server.port}/${id}`;
  const headers = (id: string) => ({ "X-One": `$mcp.env:${id}/one`, "X-Two": `$mcp.env:${id}/two` });
  const settings = path.join(data, "settings.json");
  writeFileSync(settings, JSON.stringify({ models: { "local/test": { provider: "local", model: "test", apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, contextWindow: 128000, maxTokens: 1024, input: ["text"], output: ["text"], thinking: "none" } }, mcpServers: {
    slow: { url: url("slow"), type: "http", headers: headers("slow") },
    account: { url: url("account"), type: "http", authMode: "oauth", headers: headers("account") },
    fast: { url: url("fast"), type: "http" },
    disabled: { url: url("disabled"), type: "http", disabled: true, headers: headers("disabled") },
  } }));
  mkdirSync(path.join(data, "runtime"), { recursive: true });
  const db = openDb(path.join(data, "runtime", "qone.db"));
  const workspace = new WorkspaceRepo(db).upsert("Local test", root);
  const session = new SessionRepo(db).create("Lazy MCP", workspace.id);
  closeDb(db);
  const runtime = Bun.env.QONE_AGENT_RUNTIME;
  const command = runtime ? [Bun.env.QONE_NODE_EXECUTABLE ?? Bun.which("node")!, path.resolve(runtime)]
    : [process.execPath, path.resolve(import.meta.dir, "../src/index.ts")];
  const start = () => Bun.spawn(command, {
    cwd: root, env: { ...process.env, HOME: root, USERPROFILE: root, QONE_DATA_DIR: data, QONE_DB: path.join(data, "runtime", "qone.db"), QONE_LOG_DIR: path.join(data, "logs"), QONE_MCP_SERVERS: "" },
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
  });
  let child = start(), events: RuntimeEvent[] = [];
  const send = (command: RuntimeCommand) => child.stdin.write(`${JSON.stringify(command)}\n`);
  const collect = (process: typeof child) => (async () => {
    let buffer = ""; const decoder = new TextDecoder();
    for await (const bytes of process.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) {
        const decoded = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
        events.push(...(Array.isArray(decoded) ? decoded : [decoded]));
      }
    }
  })();
  let collecting = collect(child);
  const wait = async (predicate: (event: RuntimeEvent) => boolean, from = 0) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const event = events.slice(from).find(predicate);
      if (event) return event;
      if (child.exitCode !== null) throw new Error(`Runtime exited: ${await new Response(child.stderr).text()}`);
      await Bun.sleep(10);
    }
    throw new Error(`Missing event: ${JSON.stringify(events.slice(-4))}`);
  };
  const connected = (id: string) => wait(event => event.type === "mcp.connected" && event.serverId === id);
  const restore = async (id: string, values: Record<string, string>) => {
    const request = await wait(event => event.type === "mcp.credentials.request" && event.serverId === id);
    if (request.type !== "mcp.credentials.request") throw new Error();
    send({ type: "mcp.credentials.restored", requestId: request.requestId, ok: true, values });
  };
  const stop = async () => { child.kill(); await child.exited; await collecting; };
  try {
    await wait(event => event.type === "mcp.list" && event.servers.some(server => server.id === "fast" && server.available));
    expect(handshakes.get("slow")).toBeUndefined();
    expect(handshakes.get("account")).toBeUndefined();
    expect(events.some(event => event.type === "mcp.credentials.request" && event.serverId === "fast")).toBe(false);
    const snapshotStart = events.length;
    send({ type: "mcp.list", requestId: "late-subscriber" });
    const list = await wait(event => event.type === "mcp.list" && event.servers.some(server => server.id === "slow" && server.connecting), snapshotStart);
    if (list.type !== "mcp.list") throw new Error();
    expect(list.servers.find(server => server.id === "disabled")).toMatchObject({ disabled: true, connected: false, connecting: false });
    const account = list.servers.find(server => server.id === "account")!;
    // A user click races a startup already waiting on native storage.
    send({ type: "mcp.connect", requestId: "user-click", config: account });
    await restore("account", {
      "mcp.env:account/one": "one", "mcp.env:account/two": "two",
      "mcp.oauth:account.client": '{"client_id":"local"}', "mcp.oauth:account.tokens": '{"access_token":"account-saved","token_type":"Bearer"}',
    });
    await connected("account");
    expect(events.filter(event => event.type === "mcp.credentials.request" && event.serverId === "account")).toHaveLength(1);
    expect(handshakes.get("account")).toBe(1);
    expect(events.some(event => event.type === "mcp.oauth.authorization")).toBe(false);
    const beforeDisable = events.length;
    send({ type: "mcp.disconnect", requestId: "stop-slow", serverId: "slow" });
    await wait(event => event.type === "mcp.list" && event.servers.some(server => server.id === "slow" && server.disabled && !server.connecting), beforeDisable);
    await restore("slow", { "mcp.env:slow/one": "one", "mcp.env:slow/two": "two" });
    send({ type: "ping", requestId: "after-cancel" });
    await wait(event => event.type === "pong" && event.requestId === "after-cancel");
    expect(handshakes.get("slow")).toBeUndefined();
    expect(events.some(event => event.type === "mcp.credentials.request" && event.serverId === "disabled")).toBe(false);
    expect(readFileSync(settings, "utf8")).not.toContain("account-saved");
    expect(readFileSync(settings, "utf8")).not.toContain('"connecting"');
    expect(JSON.parse(readFileSync(settings, "utf8")).mcpServers.slow.disabled).toBe(true);
    await stop(); events = []; child = start(); collecting = collect(child);
    send({ type: "mcp.list", requestId: "cached-restart" });
    await wait(event => event.type === "mcp.list" && event.servers.some(server => server.id === "fast" && server.available));
    expect(events.filter(event => event.type === "mcp.credentials.request")).toHaveLength(0);
    expect(handshakes.get("account")).toBe(1);
    expect(handshakes.get("fast")).toBe(1);
    expect(handshakes.get("slow")).toBeUndefined();
    const next = events.length;
    send({ type: "mcp.list", requestId: "wake-account-list" });
    const snapshot = await wait(event => event.type === "mcp.list" && event.servers.some(server => server.id === "account" && server.available), next);
    if (snapshot.type !== "mcp.list") throw new Error();
    send({ type: "secret.set", requestId: "local-key", key: "model.apiKey:local", value: "local-test-only" });
    send({ type: "agent.run", requestId: "wake-account", sessionId: session.id, message: "call echo", model: "local/test", mcpServerId: "account", permissionMode: "full" });
    await restore("account", {
      "mcp.env:account/one": "one", "mcp.env:account/two": "two",
      "mcp.oauth:account.client": '{"client_id":"local"}', "mcp.oauth:account.tokens": '{"access_token":"account-saved","token_type":"Bearer"}',
    });
    await wait(event => event.type === "agent.event" && ["agent.completed", "agent.failed"].includes(event.event.type));
    expect(events.filter(event => event.type === "agent.event" && event.event.type === "agent.failed")).toEqual([]);
    expect(toolCalls).toBe(1);
    expect(handshakes.get("account")).toBe(2);
    expect(handshakes.get("fast")).toBe(1);
  } finally { await stop(); server.stop(true); rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }); }
}, 20_000);
