import { expect, test } from "bun:test";
import { McpManager } from "../src/index";

const tools = [
  { name: "search", inputSchema: { type: "object" }, annotations: { readOnlyHint: true } },
  { name: "write", inputSchema: { type: "object" } },
  { name: "mutate", inputSchema: { type: "object" }, annotations: { readOnlyHint: false } },
];

test("recovery: replace a stale connection and never replay an ambiguous write", async () => {
  const sessions = new Map<string, number>();
  const attempts = new Map<string, number>();
  const writeStarted = Promise.withResolvers<void>(), releaseWrite = Promise.withResolvers<void>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (request.method === "DELETE") return new Response(null, { status: 200 });
    if (request.method !== "POST") return new Response(null, { status: 405 });
    const scenario = new URL(request.url).pathname;
    const { id, method, params } = await request.json() as { id?: number; method: string; params?: { name: string } };
    if (id === undefined) return new Response(null, { status: 202 });
    const reply = (result: unknown, headers?: HeadersInit) => Response.json({ jsonrpc: "2.0", id, result }, { headers });
    if (method === "initialize") {
      const session = (sessions.get(scenario) ?? 0) + 1;
      sessions.set(scenario, session);
      return reply({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } }, { "Mcp-Session-Id": String(session) });
    }
    if (method === "tools/list") return reply({ tools: scenario.startsWith("/changed") && sessions.get(scenario) === 2 ? [{ ...tools[0], annotations: { readOnlyHint: false } }] : tools });
    attempts.set(scenario, (attempts.get(scenario) ?? 0) + 1);
    if (scenario.startsWith("/http") && request.headers.get("Mcp-Session-Id") === "1") return new Response(null, { status: 503 });
    if (scenario === "/concurrent" && params?.name === "write") {
      writeStarted.resolve();
      await releaseWrite.promise;
      return reply({ content: [{ type: "text", text: "write finished" }] });
    }
    const failed = !scenario.startsWith("/healthy") && (request.headers.get("Mcp-Session-Id") === "1" || scenario.startsWith("/persistent"));
    const text = scenario.startsWith("/denied") ? "HTTP 401 Unauthorized" : `${params?.name} error: fetch failed`;
    return reply({ content: [{ type: "text", text: failed ? text : "ok" }], isError: failed });
  } });
  async function run(kind: string, index = 0) {
    const manager = new McpManager();
    const key = `/${kind}/${index}`;
    const config = { id: "test", name: "Test", url: `http://127.0.0.1:${server.port}${key}` };
    try {
      const initial = await manager.connect(config);
      const start = performance.now();
      const available = kind === "manual" ? await manager.connect(config, { reconnect: true }) : initial;
      const afterReconnect = sessions.get(key);
      const name = kind === "write" || kind === "mutate" ? kind : "search";
      const tool = available.find(t => t.qoneToolName?.endsWith(`:${name}`))!;
      const result = await tool.execute("call", {}, undefined, undefined, {} as never).catch(() => undefined);
      return { ok: result?.content[0]?.text === "ok", attempts: attempts.get(key), sessions: sessions.get(key), afterReconnect, ms: performance.now() - start };
    } finally { await manager.disconnectAll(); }
  }
  try {
    const count = 20;
    const measure = async (kind: string) => {
      const rows = [];
      for (let i = 0; i < count; i++) rows.push(await run(kind, i));
      const times = rows.map(row => row.ms).sort((a, b) => a - b);
      return { total: count, success: rows.filter(row => row.ok).length, attempts: rows.reduce((sum, row) => sum + (row.attempts ?? 0), 0), fresh: rows.filter(row => row.afterReconnect === 2).length, p50ms: Number(times[count / 2]!.toFixed(2)), p95ms: Number(times[Math.ceil(count * 0.95) - 1]!.toFixed(2)) };
    };
    const healthy = await measure("healthy"), manual = await measure("manual"), automatic = await measure("automatic"), http = await measure("http");
    const guards = Object.fromEntries(await Promise.all(["write", "mutate", "denied", "persistent", "changed"].map(async kind => [kind, await run(kind)] as const)));
    console.log("MCP recovery benchmark", JSON.stringify({ healthy, manual, automatic, http, guards }));
    expect(healthy).toMatchObject({ total: count, success: count, fresh: 0, attempts: count });
    expect(manual).toMatchObject({ total: count, success: count, fresh: count, attempts: count });
    for (const outcome of [automatic, http]) expect(outcome).toMatchObject({ total: count, success: count, attempts: count * 2 });
    for (const kind of ["write", "mutate", "denied"]) expect(guards[kind]).toMatchObject({ ok: false, attempts: 1, sessions: 1 });
    expect(guards.persistent).toMatchObject({ ok: false, attempts: 2, sessions: 2 });
    expect(guards.changed).toMatchObject({ ok: false, attempts: 1, sessions: 2 });
    const manager = new McpManager();
    try {
      const config = { id: "concurrent", name: "Concurrent", url: `http://127.0.0.1:${server.port}/concurrent` };
      const [search, write] = await manager.connect(config);
      const writing = write!.execute("write", {}, undefined, undefined, {} as never);
      void writing.catch(() => {});
      await writeStarted.promise;
      try {
        const failed = await search!.execute("search", {}, undefined, undefined, {} as never);
        expect(failed.content[0]?.text).toBe("search error: fetch failed");
        expect(sessions.get("/concurrent")).toBe(1);
      } finally { releaseWrite.resolve(); }
      expect((await writing).content[0]?.text).toBe("write finished");
      expect(attempts.get("/concurrent")).toBe(2);
    } finally { await manager.disconnectAll(); }
  } finally { server.stop(true); }
}, 15_000);
