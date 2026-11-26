import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ConfigFile, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent, ServerInfo } from "@qone/protocol";
import { PiAdapter } from "../src/pi-adapter.js";
import { ServerService } from "../src/servers/server-service.js";

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
  const titleRequests: Captured[] = [];
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
    const isTitle = text.includes("conversation title");
    const turn = isTitle ? undefined : [...text.matchAll(/CACHE_E2E_TURN_(\d)/g)].at(-1)?.[1];
    if (isTitle) titleRequests.push({ api, turn: "title", body, headers: Object.fromEntries(request.headers) });
    if (turn) captured.push({ api, turn, body, headers: Object.fromEntries(request.headers) });
    if (turn === "1" && !searched.has(api)) { searched.add(api); return searchCall(api); }
    return reply(api, turn ? `ANSWER_${turn}` : "{\"title\":\"t\"}");
  } });
  const database = path.join(directory, "agent.db");
  await writeFile(path.join(directory, "AGENT.md"), "PROJECT_AGENT_RULE_STABLE\n", "utf8");
  await writeFile(path.join(directory, "CLAUDE.md"), "PROJECT_CLAUDE_RULE_STABLE\n", "utf8");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("Cache E2E", directory);
  const sessions = APIS.map(() => new SessionRepo(db).create("New session", workspace.id));
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
    // 并发触发四个接口的自动取名，验证标题请求不带 cache_control / prompt_cache_key，且不污染主会话缓存。
    await Promise.all(APIS.map((api, index) => send({
      type: "session.generate-title", requestId: `title-${api}`, sessionId: sessions[index]!.id,
      prompt: `CACHE_E2E_TITLE_${api}`, model: `cache-${api}/m`,
    })));
    await wait(() => titleRequests.length === APIS.length);
    for (const req of titleRequests) {
      const bodyText = JSON.stringify(req.body);
      expect({ api: req.api, hasCacheControl: bodyText.includes("cache_control") }).toEqual({ api: req.api, hasCacheControl: false });
      expect({ api: req.api, promptCacheKey: req.body.prompt_cache_key }).toEqual({ api: req.api, promptCacheKey: undefined });
      expect(bodyText).not.toContain("PROJECT_AGENT_RULE_STABLE");
      expect(bodyText).not.toContain("PROJECT_CLAUDE_RULE_STABLE");
    }
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
      // 验证 AGENT.md 与 CLAUDE.md 已注入四个接口的系统提示词且跨轮/重启后 head 字节一致。
      for (const item of [first, second, third]) {
        const snapshot = prompt(api, item.body);
        const systemText = JSON.stringify(api === "openai-compatible" || api === "codex" ? snapshot.items[0] : snapshot.head);
        expect(systemText).toContain("PROJECT_AGENT_RULE_STABLE");
        expect(systemText).toContain("PROJECT_CLAUDE_RULE_STABLE");
      }
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

test("loading deferred server_exec, flipping transient server status, and background completeText keep all four APIs' cached head intact", async () => {
  const captured: Captured[] = [];
  const memoryRequests: Captured[] = [];
  const searched = new Set<string>();
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const url = new URL(request.url);
    const api = APIS.find((name) => url.pathname.startsWith(`/${name}/`));
    const generation = url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/responses")
      || url.pathname.endsWith("/messages") || url.pathname.includes(":streamGenerateContent");
    if (!api || !generation) return Response.json({ data: [], models: [] });
    const body = await request.json() as Record<string, any>;
    const text = JSON.stringify(body);
    if (text.includes("MEMORY_CACHE_ISOLATION_PROBE")) {
      memoryRequests.push({ api, turn: "memory", body, headers: Object.fromEntries(request.headers) });
      return reply(api, "summary");
    }
    const turn = [...text.matchAll(/SERVER_CACHE_TURN_(\d)/g)].at(-1)?.[1];
    if (turn) captured.push({ api, turn, body, headers: Object.fromEntries(request.headers) });
    if (turn === "1" && !searched.has(api)) {
      searched.add(api);
      // 模拟对话中途通过 tool_search 激活带 promptSnippet 的延迟工具 server_exec。
      const id = `call_srv_${api.replace(/\W/g, "_")}`;
      const args = JSON.stringify({ query: "SSH server execute command" });
      if (api === "openai-compatible") return sse([
        [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id, type: "function", function: { name: "tool_search", arguments: args } }] }, finish_reason: null }] }],
        [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
      ], true);
      if (api === "codex") {
        const item = { type: "function_call", id: "fc_srv_search", call_id: id, name: "tool_search", arguments: args, status: "completed" };
        return sse([
          ["response.created", { type: "response.created", response: { id: "resp", status: "in_progress" } }],
          ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }],
          ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
          ["response.completed", { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }],
        ]);
      }
      if (api === "claude") return sse([
        ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
        ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id, name: "tool_search", input: {} } }],
        ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }],
        ["content_block_stop", { type: "content_block_stop", index: 0 }],
        ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
        ["message_stop", { type: "message_stop" }],
      ]);
      return sse([[undefined, { candidates: [{ content: { role: "model", parts: [{ functionCall: { id, name: "tool_search", args: { query: "SSH server execute command" } } }] }, finishReason: "STOP" }] }]]);
    }
    return reply(api, `OK_${turn ?? "0"}`);
  } });

  const srv: ServerInfo = { id: "srv-1", name: "Prod", host: "10.0.0.1", port: 22, username: "root", system: "Linux", auth: { kind: "agent" }, status: "offline", createdAt: 0 };
  const storeValues = new Map<string, unknown>([["servers.list", [srv]]]);
  const serverService = new ServerService({
    get: (key: string) => structuredClone(storeValues.get(key)),
    set: (key: string, value: unknown) => storeValues.set(key, value),
  } as never, () => {}, async () => {});
  const histories = new Map<string, Array<{ role: string; content: string; rawMessage: unknown; createdAt: number }>>();
  const adapter = new PiAdapter((event) => {
    if (event.type !== "message.completed" || !event.sessionId) return;
    const rawMessage = (event.payload as { message?: { role?: string } }).message;
    if (!rawMessage?.role || !["user", "assistant", "toolResult"].includes(rawMessage.role)) return;
    const list = histories.get(event.sessionId) ?? [];
    list.push({ role: rawMessage.role, content: "", rawMessage, createdAt: Date.now() });
    histories.set(event.sessionId, list);
  }, {
    serverTools: (cwd, ids) => serverService.tools(cwd, ids),
    serverSummary: (ids) => serverService.summary(ids),
    serverTargets: (ids) => serverService.executionTargets(ids),
  }, undefined, (sessionId) => histories.get(sessionId) ?? []);

  const base = `http://127.0.0.1:${server.port}`;
  const baseUrls: Record<string, string> = { "openai-compatible": `${base}/openai-compatible/v1`, codex: `${base}/codex/v1`, claude: `${base}/claude`, google: `${base}/google/v1beta` };
  try {
    await adapter.configureModels(APIS.map((api) => ({
      id: `srv-${api}/m`, provider: `srv-${api}`, model: "m", enabled: true, updatedAt: 1,
      config: { apiType: api, baseUrl: baseUrls[api], thinking: "none", autoMetadata: false, contextWindow: 128000, maxTokens: 4096, input: ["text"], output: ["text"] },
    })));
    for (const api of APIS) await adapter.setSecret(`model.apiKey:srv-${api}`, "local-test-only");

    for (const api of APIS) {
      const sid = `srv-session-${api}`;
      await adapter.run(sid, "SERVER_CACHE_TURN_1", { cwd: process.cwd(), model: `srv-${api}/m`, permissionMode: "full", serverIds: ["srv-1"] }, () => {});
      // 模拟后台连接恢复仅翻转服务器 status（offline -> ready），不改静态元数据。
      serverService.registry.update("srv-1", { status: "ready" });
      // 触发后台记忆整理 completeText，验证其不写入 cache_control / prompt_cache_key。
      await adapter.completeText(`srv-${api}/m`, undefined, "MEMORY_CACHE_ISOLATION_PROBE", "summarize", 64, new AbortController().signal);
      await adapter.run(sid, "SERVER_CACHE_TURN_2", { cwd: process.cwd(), model: `srv-${api}/m`, permissionMode: "full", serverIds: ["srv-1"] }, () => {});
      serverService.registry.update("srv-1", { status: "offline" });
    }

    expect(memoryRequests).toHaveLength(APIS.length);
    for (const req of memoryRequests) {
      expect({ api: req.api, hasCacheControl: JSON.stringify(req.body).includes("cache_control") }).toEqual({ api: req.api, hasCacheControl: false });
      expect({ api: req.api, promptCacheKey: req.body.prompt_cache_key }).toEqual({ api: req.api, promptCacheKey: undefined });
    }

    for (const api of APIS) {
      const turn1Reqs = captured.filter((item) => item.api === api && item.turn === "1");
      const turn2Reqs = captured.filter((item) => item.api === api && item.turn === "2");
      expect({ api, counts: [turn1Reqs.length, turn2Reqs.length] }).toEqual({ api, counts: [2, 1] });
      const afterLoad = prompt(api, turn1Reqs[1]!.body);
      const nextTurn = prompt(api, turn2Reqs[0]!.body);
      // 关键断言：即便中途加载了 server_exec 且次轮重建前服务器 status 发生变化，head（system + tools）与历史前缀必须完全字节一致。
      expect({ api, head: nextTurn.head }).toEqual({ api, head: afterLoad.head });
      expect({ api, prefix: nextTurn.items.slice(0, afterLoad.items.length) }).toEqual({ api, prefix: afterLoad.items });
    }
  } finally {
    await adapter.invalidateSessions();
    serverService.dispose();
    server.stop(true);
  }
}, 30000);
