import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, ConfigFile, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

// Real runtime + local SSE provider. Three models report cache data differently:
// one sends cached tokens, one an explicit `cached_tokens: 0` (a real miss), one omits
// the field entirely (unknown). Nothing here is paid or leaves the machine.

function sse(events: object[]): Response {
  return new Response(events.map((data) => `data: ${JSON.stringify(data)}\n\n`).join("") + "data: [DONE]\n\n",
    { headers: { "Content-Type": "text/event-stream" } });
}

/** One streamed chat completion with the given usage on its final chunk. */
function reply(text: string, served: number, payload: object): Response {
  const id = `chatcmpl-${served}`;
  return sse([
    { id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] },
    { id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: payload },
  ]);
}

const CHAT_REPLY = "ANSWER";
const HIT_USAGE = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 60 } };
const MISS_USAGE = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105, prompt_tokens_details: { cached_tokens: 0 } };
const ABSENT_USAGE = { prompt_tokens: 100, completion_tokens: 5, total_tokens: 105 };

type UsageRow = { provider: string; model: string; source: string; cache: string; input: number; output: number; cacheRead: number };

test("real provider streaming records one usage row per request with distinct cache data", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-usage-e2e-"));
  let served = 0;
  const perProvider: Record<string, number> = {};
  const adviceRequests: { messages: { role: string; content: unknown }[]; tools?: unknown }[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    if (!url.pathname.endsWith("/chat/completions")) return Response.json({ data: [], models: [] });
    const payload = await request.json() as (typeof adviceRequests)[number];
    served++;
    const provider = url.pathname.split("/")[1] ?? "";
    perProvider[provider] = (perProvider[provider] ?? 0) + 1;
    if (Array.isArray(payload.tools) && payload.tools.length && JSON.stringify(payload.messages.findLast(({ role }) => role === "user")?.content).includes("ADVICE_PREFIX_CASE")) {
      adviceRequests.push(payload);
      if (adviceRequests.length === 1) {
        const id = `chatcmpl-${served}`;
        const tool = process.platform === "win32" ? "powershell" : "bash";
        return sse([
          { id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, finish_reason: null, delta: { role: "assistant", tool_calls: [{ index: 0, id: "check-cache-prefix", type: "function", function: { name: tool, arguments: '{"command":"rg needle src/*.ts"}' } }] } }] },
          { id, object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, finish_reason: "tool_calls", delta: {} }], usage: HIT_USAGE },
        ]);
      }
    }
    const usage = provider === "cache-hit" ? HIT_USAGE : provider === "cache-miss" ? MISS_USAGE : ABSENT_USAGE;
    return reply(CHAT_REPLY, served, usage);
  } });
  const database = path.join(directory, "agent.db");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("Usage E2E", directory);
  const providers = ["cache-hit", "cache-miss", "cache-absent"];
  const sessions = providers.map((name) => new SessionRepo(db).create(name, workspace.id));
  const base = `http://127.0.0.1:${server.port}`;
  const settingsFile = new ConfigFile(path.join(directory, "settings.json"));
  for (const name of providers) {
    new ModelConfigRepo(settingsFile).upsert({ provider: name, model: "m", enabled: true, config: {
      apiType: "openai-compatible", baseUrl: `${base}/${name}/v1`, thinking: "none", autoMetadata: false,
      contextWindow: 128000, maxTokens: 4096, input: ["text"], output: ["text"],
    } });
  }
  closeDb(db);
  const child = Bun.spawn([Bun.which("bun")!, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, QONE_DATA_DIR: directory, QONE_DB: database, APPDATA: directory,
      QONE_LOG_DIR: path.join(directory, "logs"), QONE_PLUGINS_DIR: path.join(directory, "plugins") },
  });
  const events: RuntimeEvent[] = [];
  const output = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of child.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) { const value = JSON.parse(line); events.push(...(Array.isArray(value) ? value : [value])); }
    }
  })();
  const stderr = new Response(child.stderr).text();
  const send = (command: RuntimeCommand) => { child.stdin.write(JSON.stringify(command) + "\n"); return child.stdin.flush(); };
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout waiting for ${label}: ${JSON.stringify(events.filter((event) => event.type === "error" || event.type === "agent.event").slice(-4))}`);
      await Bun.sleep(5);
    }
  };
  const readRows = () => {
    const raw = new DatabaseSync(database);
    try {
      return raw.prepare("SELECT provider, model, source, cache, input, output, cache_read AS cacheRead FROM execution_usage").all() as UsageRow[];
    } finally { raw.close(); }
  };
  try {
    for (const name of providers) {
      await send({ type: "secret.set", requestId: `key-${name}`, key: `model.apiKey:${name}`, value: "local-test-only" });
    }
    await wait(() => events.filter((event) => event.type === "secret.saved").length >= providers.length, "keys");
    const completed = () => events.filter((event) => event.type === "agent.event" && event.event.type === "agent.completed").length;
    const failed = () => events.filter((event) => event.type === "agent.event" && event.event.type === "agent.failed");
    const started = completed();
    for (const [index, name] of providers.entries()) {
      await send({ type: "agent.run", requestId: `run-${name}`, sessionId: sessions[index]!.id, message: `USAGE_E2E_${name}`, model: `${name}/m`, permissionMode: "full" });
    }
    await wait(() => completed() === started + providers.length, "chat turns");
    expect(failed()).toEqual([]);
    await wait(() => readRows().length >= providers.length, "usage rows");

    const rows = readRows();
    const chat = rows.filter((row) => row.source === "chat");
    // One row per chat request: the request's own final usage chunk is the only source.
    expect(chat).toHaveLength(providers.length);
    expect(chat.filter((row) => row.provider === "cache-hit")).toEqual([
      { provider: "cache-hit", model: "m", source: "chat", cache: "reported", input: 40, output: 5, cacheRead: 60 },
    ]);
    // An explicit zero is a reported miss: known denominator, zero hits.
    expect(chat.filter((row) => row.provider === "cache-miss")).toEqual([
      { provider: "cache-miss", model: "m", source: "chat", cache: "reported", input: 100, output: 5, cacheRead: 0 },
    ]);
    // A missing field stays unknown instead of becoming a false 0% hit rate.
    expect(chat.filter((row) => row.provider === "cache-absent")).toEqual([
      { provider: "cache-absent", model: "m", source: "chat", cache: "unknown", input: 100, output: 5, cacheRead: 0 },
    ]);
    // Every provider was asked exactly once: no duplicated request, no phantom retry.
    expect(perProvider).toEqual({ "cache-hit": 1, "cache-miss": 1, "cache-absent": 1 });

    // The statistics command reports the same attribution, with a token-weighted hit rate.
    await send({ type: "stats.get", requestId: "stats", range: "today" });
    await wait(() => events.some((event) => event.type === "stats.state"), "stats state");
    const state = (events.find((event) => event.type === "stats.state") as Extract<RuntimeEvent, { type: "stats.state" }>).state;
    const row = (provider: string) => {
      const match = state.period.rows.find((item) => item.provider === provider);
      expect(match).toBeDefined();
      return { requests: match!.requests, inputTokens: match!.inputTokens, outputTokens: match!.outputTokens, cacheReadTokens: match!.cacheReadTokens, cacheHitRate: match!.cacheHitRate };
    };
    expect(row("cache-hit")).toEqual({ requests: 1, inputTokens: 40, outputTokens: 5, cacheReadTokens: 60, cacheHitRate: 60 });
    // 0 hits over 100 uncached tokens: a real 0%, not unknown.
    expect(row("cache-miss")).toEqual({ requests: 1, inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheHitRate: 0 });
    // Unknown never enters the ratio.
    expect(row("cache-absent")).toEqual({ requests: 1, inputTokens: 100, outputTokens: 5, cacheReadTokens: 0, cacheHitRate: undefined });
    expect(state.period.sources.map((group) => group.source)).toEqual(["chat"]);
    expect(state.recording).toBe(true);
    expect(state.memoryAccess).toBe(false);
    expect(state.incidents).toEqual([]);

    if (process.platform === "win32") {
      const enable = async (command: RuntimeCommand & { requestId: string }) => {
        await send(command);
        await wait(() => events.some((event) => (event.type === "stats.state" || event.type === "memory.state") && event.requestId === command.requestId), command.requestId);
      };
      await enable({ type: "memory.enabled.set", requestId: "memory", enabled: true });
      await enable({ type: "stats.record.set", record: false, requestId: "pause-record" });
      await enable({ type: "stats.record.set", record: true, requestId: "record" });
      await enable({ type: "stats.memoryAccess.set", enabled: true, requestId: "global" });
      const raw = new DatabaseSync(database);
      try {
        raw.prepare("INSERT INTO execution_lessons (id,provider,model,tool,reason,advice,at) VALUES (?,?,?,?,?,?,?)")
          .run("test-advice", "cache-hit", "m", "powershell", "missing-path", "rg-path", Date.now() + 1);
      } finally { raw.close(); }
      await send({ type: "agent.run", requestId: "cache-prefix", sessionId: sessions[0]!.id, message: "ADVICE_PREFIX_CASE", model: "cache-hit/m", permissionMode: "full" });
      await wait(() => completed() === started + providers.length + 1, "appended advice");
      expect(adviceRequests).toHaveLength(2);
      const [first, second] = adviceRequests;
      expect(JSON.stringify(second!.messages.slice(0, first!.messages.length))).toBe(JSON.stringify(first!.messages));
      expect(JSON.stringify(second!.tools)).toBe(JSON.stringify(first!.tools));
      expect(JSON.stringify(first)).not.toContain("Execution tip:");
      expect(JSON.stringify(second!.messages.at(-1)?.content)).toContain("Execution tip: For rg on PowerShell");
    }
  } finally {
    child.kill(); await child.exited; await output; await stderr;
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 120000);
