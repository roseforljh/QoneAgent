import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ConfigFile, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

// Real runtime process + local HTTP/SSE servers for the four wire formats. No
// credentials or paid requests: the servers only record what a provider would
// receive, so cache-relevant request prefixes can be compared exactly.
type Captured = { api: string; turn: string; body: Record<string, any>; headers: Record<string, string> };
const APIS = ["openai-compatible", "codex", "claude", "google"] as const;

function sse(events: [string | undefined, object][], done = false): Response {
  return new Response(events.map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("")
    + (done ? "data: [DONE]\n\n" : ""), { headers: { "Content-Type": "text/event-stream" } });
}

function reply(api: string, text: string): Response {
  if (api === "openai-compatible") return sse([
    [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }],
    [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }],
  ], true);
  if (api === "codex") {
    const item = { type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    return sse([
      ["response.created", { type: "response.created", response: { id: "resp", status: "in_progress" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }],
      ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12, input_tokens_details: { cached_tokens: 0 } } } }],
    ]);
  }
  if (api === "claude") return sse([
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
  return sse([[undefined, { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }]]);
}

const searchId = (api: string) => `call_cache_search_${api.replace(/\W/g, "_")}`;
const SEARCH_ARGS = { query: "douyin videos" };

/** Turn 1 loads an on-demand tool, so the restored loadout is part of the cached prefix. */
function searchCall(api: string): Response {
  const SEARCH_ID = searchId(api);
  const args = JSON.stringify(SEARCH_ARGS);
  if (api === "openai-compatible") return sse([
    [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: SEARCH_ID, type: "function", function: { name: "tool_search", arguments: args } }] }, finish_reason: null }] }],
    [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
  ], true);
  if (api === "codex") {
    const item = { type: "function_call", id: "fc_cache_search", call_id: SEARCH_ID, name: "tool_search", arguments: args, status: "completed" };
    return sse([
      ["response.created", { type: "response.created", response: { id: "resp", status: "in_progress" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }],
    ]);
  }
  if (api === "claude") return sse([
    ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
    ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: SEARCH_ID, name: "tool_search", input: {} } }],
    ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }],
    ["content_block_stop", { type: "content_block_stop", index: 0 }],
    ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
    ["message_stop", { type: "message_stop" }],
  ]);
  return sse([[undefined, { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: SEARCH_ID, name: "tool_search", args: SEARCH_ARGS } }] }, finishReason: "STOP" }] }]]);
}

const toolNames = (body: Record<string, any>) => JSON.stringify(body.tools ?? []).match(/qone_douyin_/g)?.length ?? 0;

/** The cache-relevant prompt in provider order, without per-request breakpoint markers. */
function prompt(api: string, body: Record<string, any>) {
  const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null, (key, item) => key === "cache_control" ? undefined : item));
  if (api === "openai-compatible") return { head: strip({ tools: body.tools }), items: strip(body.messages) as unknown[] };
  if (api === "codex") return { head: strip({ instructions: body.instructions, tools: body.tools }), items: strip(body.input) as unknown[] };
  if (api === "claude") return { head: strip({ system: body.system, tools: body.tools }), items: strip(body.messages) as unknown[] };
  return { head: strip({ systemInstruction: body.systemInstruction, tools: body.tools }), items: strip(body.contents) as unknown[] };
}

test("all four provider formats keep a byte-stable cached prefix and cache identity across turns and restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-cache-e2e-"));
  const captured: Captured[] = [];
  const searched = new Set<string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const api = APIS.find((name) => url.pathname.startsWith(`/${name}/`));
    const generation = url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/responses")
      || url.pathname.endsWith("/messages") || url.pathname.includes(":streamGenerateContent");
    if (!api || !generation) return Response.json({ data: [], models: [] });
    const body = await request.json() as Record<string, any>;
    const text = JSON.stringify(body);
    // Title generation quotes the first prompt but is a separate one-shot request.
    const turn = text.includes("conversation title") ? undefined : [...text.matchAll(/CACHE_E2E_TURN_(\d)/g)].at(-1)?.[1];
    if (turn) captured.push({ api, turn, body, headers: Object.fromEntries(request.headers) });
    if (turn === "1" && !searched.has(api)) { searched.add(api); return searchCall(api); }
    return reply(api, turn ? `ANSWER_${turn}` : "{\"title\":\"t\"}");
  } });
  const database = path.join(directory, "agent.db");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("Cache E2E", directory);
  const sessions = APIS.map((api) => new SessionRepo(db).create(`cache-${api}`, workspace.id));
  const base = `http://127.0.0.1:${server.port}`;
  const baseUrls: Record<string, string> = { "openai-compatible": `${base}/openai-compatible/v1`, codex: `${base}/codex/v1`, claude: `${base}/claude`, google: `${base}/google/v1beta` };
  for (const api of APIS) new ModelConfigRepo(new ConfigFile(path.join(directory, "settings.json"))).upsert({ provider: `cache-${api}`, model: "m", enabled: true, config: {
    apiType: api, baseUrl: baseUrls[api], thinking: "none", autoMetadata: false,
    contextWindow: 128000, maxTokens: 4096, input: ["text"], output: ["text"],
  } });
  closeDb(db);
  const spawn = () => Bun.spawn([Bun.which("bun")!, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, QONE_DATA_DIR: directory, QONE_DB: database, APPDATA: directory,
      QONE_LOG_DIR: path.join(directory, "logs"), QONE_PLUGINS_DIR: path.join(directory, "plugins") },
  });
  let child = spawn(), events: RuntimeEvent[] = [];
  const collect = (process: typeof child) => (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of process.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) { const value = JSON.parse(line); events.push(...(Array.isArray(value) ? value : [value])); }
    }
  })();
  let output = collect(child), stderr = new Response(child.stderr).text();
  const send = async (command: RuntimeCommand) => { child.stdin.write(JSON.stringify(command) + "\n"); await child.stdin.flush(); };
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`timeout: ${JSON.stringify(events.filter((event) => event.type === "error" || (event.type === "agent.event" && /failed|error/.test(event.event.type))))}`);
      await Bun.sleep(5);
    }
  };
  const completed = () => events.filter((event) => event.type === "agent.event" && event.event.type === "agent.completed").length;
  const setKeys = async () => {
    for (const api of APIS) await send({ type: "secret.set", requestId: `key-${api}`, key: `model.apiKey:cache-${api}`, value: "local-test-only" });
    await wait(() => events.filter((event) => event.type === "secret.saved").length >= APIS.length);
  };
  const turn = async (number: number) => {
    const before = completed();
    await Promise.all(APIS.map((api, index) => send({ type: "agent.run", requestId: `${api}-${number}`, sessionId: sessions[index]!.id,
      message: `CACHE_E2E_TURN_${number}`, model: `cache-${api}/m`, permissionMode: "full" })));
    await wait(() => completed() === before + APIS.length);
    expect(events.filter((event) => event.type === "agent.event" && event.event.type === "agent.failed")).toEqual([]);
  };
  try {
    await setKeys();
    await turn(1);
    await turn(2);
    child.kill(); await child.exited; await output; await stderr;
    events = []; child = spawn(); output = collect(child); stderr = new Response(child.stderr).text();
    await setKeys();
    await turn(3);
    for (const api of APIS) {
      const requests = ["1", "2", "3"].map((number) => captured.filter((item) => item.api === api && item.turn === number));
      expect({ api, counts: requests.map((list) => list.length) }).toEqual({ api, counts: [2, 1, 1] });
      const [first, second, third] = [requests[0]![1]!, requests[1]![0]!, requests[2]![0]!];
      // tool_search declared the on-demand tool for the rest of the conversation.
      expect({ api, loaded: [first, second, third].map((item) => toolNames(item.body) > 0) }).toEqual({ api, loaded: [true, true, true] });
      for (const [previous, next, loadsTools] of [[requests[0]![0]!, first, true], [first, second, false], [second, third, false]] as const) {
        const before = prompt(api, previous.body), after = prompt(api, next.body);
        // Anything before the newest turn must be byte-identical for a provider prefix hit;
        // only the request right after tool_search may declare more tools.
        if (!loadsTools) expect({ api, head: after.head }).toEqual({ api, head: before.head });
        expect({ api, prefix: after.items.slice(0, before.items.length) }).toEqual({ api, prefix: before.items });
        expect(after.items.length).toBeGreaterThan(before.items.length);
      }
      // The on-demand catalog is sent once per conversation, not again after each rebuild.
      expect({ api, catalogs: JSON.stringify(third.body).split("<on-demand-tools>").length - 1 }).toEqual({ api, catalogs: 1 });
      // Third-party Chat Completions endpoints only get the key when Pi knows they accept it.
      const sessionId = sessions[APIS.indexOf(api)]!.id;
      const keys = [first!, second!, third!].map((item) => item.body.prompt_cache_key);
      if (api === "codex") expect({ api, keys }).toEqual({ api, keys: [sessionId, sessionId, sessionId] });
      if (api === "openai-compatible") expect({ api, keys }).toEqual({ api, keys: [undefined, undefined, undefined] });
      if (api === "claude") {
        for (const item of [first!, second!, third!]) {
          expect(JSON.stringify(item.body.system)).toContain("cache_control");
          expect(JSON.stringify(item.body.messages.at(-1))).toContain("cache_control");
        }
      }
    }
  } finally {
    child.kill(); await child.exited; await output; await stderr;
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90000);
