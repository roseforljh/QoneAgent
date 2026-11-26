import { expect, test } from "bun:test";
import { closeDb, openDb, TeamRepo } from "@qone/database";
import type { ServerInfo, TeamBot } from "@qone/protocol";
import { PiAdapter } from "../src/pi-adapter.js";
import { ServerService } from "../src/servers/server-service.js";
import { PiTeamTurnRunner } from "../src/team/team-agent-runner.js";
import { createVerdictTool } from "../src/team/team-handoff.js";
import { createTeamPlanTool } from "../src/team/team-plan-engine.js";
import type { TeamRunRecord } from "../src/team/team-records.js";
import { TeamService } from "../src/team/team-service.js";

type Captured = { api: string; body: Record<string, unknown> };
const APIS = ["openai-compatible", "codex", "claude", "google"] as const;

function sse(events: [string | undefined, object][], done = false): Response {
  return new Response(
    events.map(([name, data]) => `${name ? `event: ${name}\n` : ""}data: ${JSON.stringify(data)}\n\n`).join("")
      + (done ? "data: [DONE]\n\n" : ""),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}

function reply(api: string, text: string): Response {
  if (api === "openai-compatible") {
    return sse([
      [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] }],
      [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } }],
    ], true);
  }
  if (api === "codex") {
    const item = { type: "message", id: `msg_${crypto.randomUUID()}`, role: "assistant", status: "completed", content: [{ type: "output_text", text, annotations: [] }] };
    return sse([
      ["response.created", { type: "response.created", response: { id: "resp", status: "in_progress" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, content: [] } }],
      ["response.output_text.delta", { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: text }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }],
    ]);
  }
  if (api === "claude") {
    return sse([
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "text_delta", text } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  }
  return sse([[undefined, { candidates: [{ content: { role: "model", parts: [{ text }] }, finishReason: "STOP" }], usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }]]);
}

function toolCall(api: string, callId: string, name: string, argsObj: Record<string, unknown>): Response {
  const args = JSON.stringify(argsObj);
  if (api === "openai-compatible") {
    return sse([
      [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: callId, type: "function", function: { name, arguments: args } }] }, finish_reason: null }] }],
      [undefined, { id: "c", object: "chat.completion.chunk", created: 1, model: "m", choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] }],
    ], true);
  }
  if (api === "codex") {
    const item = { type: "function_call", id: `fc_${callId}`, call_id: callId, name, arguments: args, status: "completed" };
    return sse([
      ["response.created", { type: "response.created", response: { id: "resp", status: "in_progress" } }],
      ["response.output_item.added", { type: "response.output_item.added", output_index: 0, item: { ...item, arguments: "" } }],
      ["response.output_item.done", { type: "response.output_item.done", output_index: 0, item }],
      ["response.completed", { type: "response.completed", response: { id: "resp", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } }],
    ]);
  }
  if (api === "claude") {
    return sse([
      ["message_start", { type: "message_start", message: { id: "m", type: "message", role: "assistant", model: "m", content: [], usage: { input_tokens: 10, output_tokens: 0 } } }],
      ["content_block_start", { type: "content_block_start", index: 0, content_block: { type: "tool_use", id: callId, name, input: {} } }],
      ["content_block_delta", { type: "content_block_delta", index: 0, delta: { type: "input_json_delta", partial_json: args } }],
      ["content_block_stop", { type: "content_block_stop", index: 0 }],
      ["message_delta", { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 2 } }],
      ["message_stop", { type: "message_stop" }],
    ]);
  }
  return sse([[undefined, { candidates: [{ content: { role: "model", parts: [{ functionCall: { id: callId, name, args: argsObj } }] }, finishReason: "STOP" }] }]]);
}

function promptHead(api: string, body: Record<string, unknown>) {
  const strip = (value: unknown): unknown => JSON.parse(JSON.stringify(value ?? null, (key, item) => key === "cache_control" ? undefined : item));
  if (api === "openai-compatible") {
    const messages = body.messages as Array<{ role?: string }> | undefined;
    return strip({ system: messages?.find((item) => item.role === "system" || item.role === "developer"), tools: body.tools });
  }
  if (api === "codex") {
    const input = body.input as Array<{ role?: string }> | undefined;
    return strip({ instructions: body.instructions, system: input?.find((item) => item.role === "developer" || item.role === "system"), tools: body.tools });
  }
  if (api === "claude") return strip({ system: body.system, tools: body.tools });
  return strip({ systemInstruction: body.systemInstruction, tools: body.tools });
}

function firstUserText(api: string, body: Record<string, unknown>): string {
  if (api === "openai-compatible") {
    const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
    const content = messages?.find((item) => item.role === "user")?.content;
    return typeof content === "string" ? content : JSON.stringify(content ?? "");
  }
  if (api === "codex") {
    const input = body.input as Array<{ role?: string; content?: unknown }> | undefined;
    const content = input?.find((item) => item.role === "user")?.content;
    return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : String(content ?? "");
  }
  if (api === "claude") {
    const messages = body.messages as Array<{ role?: string; content?: unknown }> | undefined;
    const content = messages?.find((item) => item.role === "user")?.content;
    return Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? "").join("") : String(content ?? "");
  }
  const contents = body.contents as Array<{ role?: string; parts?: Array<{ text?: string }> }> | undefined;
  const parts = contents?.find((item) => item.role === "user")?.parts;
  return Array.isArray(parts) ? parts.map((part) => part.text ?? "").join("") : "";
}

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 600; i++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(`timed out waiting for ${label}`);
}

const makeBot = (id: string, name: string): TeamBot => ({
  id, name, roleTitle: name, description: "", systemPrompt: `${name} 的人设`, logo: "robot", modelId: "",
  capabilities: [], source: "custom", createdAt: 1, updatedAt: 1,
});

test("inactive team_plan and team_verdict placeholders reject calls outside their phase", async () => {
  const plan = createTeamPlanTool();
  const verdict = createVerdictTool();
  await expect(plan.execute("c1", { steps: [] } as never, undefined, undefined, undefined as never)).rejects.toThrow("planning turn");
  await expect(verdict.execute("c2", { verdict: "pass", failures: [] } as never, undefined, undefined, undefined as never)).rejects.toThrow("verification turn");
});

test("team multi-step workflow keeps byte-stable head, cache key, shared prompt prefix, and isolated disposal across all 4 APIs", async () => {
  const teamCaptured = new Map<string, Captured[]>();
  const mainCaptured = new Map<string, Captured[]>();
  const srv: ServerInfo = { id: "srv-1", name: "Prod", host: "10.0.0.1", port: 22, username: "root", system: "Linux", auth: { kind: "agent" }, status: "offline", createdAt: 0 };
  const storeValues = new Map<string, unknown>([["servers.list", [srv]]]);
  const serverService = new ServerService({
    get: (key: string) => structuredClone(storeValues.get(key)),
    set: (key: string, value: unknown) => storeValues.set(key, value),
  } as never, () => {}, async () => {});

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const api = APIS.find((name) => url.pathname.startsWith(`/${name}/`));
      const generation = url.pathname.endsWith("/chat/completions") || url.pathname.endsWith("/responses")
        || url.pathname.endsWith("/messages") || url.pathname.includes(":streamGenerateContent");
      if (!api || !generation) return Response.json({ data: [], models: [] });
      const body = await request.json() as Record<string, unknown>;
      const raw = JSON.stringify(body);
      if (raw.includes("MAIN_CHAT_TURN_")) {
        const list = mainCaptured.get(api) ?? [];
        list.push({ api, body });
        mainCaptured.set(api, list);
        return reply(api, "MAIN_OK");
      }
      const list = teamCaptured.get(api) ?? [];
      list.push({ api, body });
      teamCaptured.set(api, list);
      if (raw.includes("You coordinate this group.") && !raw.includes("Plan accepted")) {
        return toolCall(api, `plan_${api}`, "team_plan", {
          steps: [
            { id: "s1", botId: "eng", title: "实现", task: "实现接口" },
            { id: "v1", botId: "rev", title: "验收", task: "验收接口", verifies: "s1" },
          ],
        });
      }
      if (raw.includes("You coordinate this group.")) return reply(api, "已拆分实现与验收。");
      if (raw.includes("You are the independent checker") && !raw.includes("Verdict recorded")) {
        return toolCall(api, `verdict_${api}`, "team_verdict", { verdict: "pass", failures: [] });
      }
      if (raw.includes("You are the independent checker")) return reply(api, "验收通过。");
      if (raw.includes("Write the final answer for the user")) return reply(api, "全部完成并验收通过。");
      // 模拟工作步骤执行期间 SSH 服务器状态翻转 offline -> ready。
      serverService.registry.update("srv-1", { status: "ready" });
      return reply(api, "已完成实现。");
    },
  });

  // 不传入 restoreMessages，额外验证隔离会话依然会在结束后被强制 dispose。
  let teamRunner!: PiTeamTurnRunner;
  const adapter = new PiAdapter((event) => {
    teamRunner.observe(event);
  }, {
    serverTools: (cwd, ids) => serverService.tools(cwd, ids),
    serverSummary: (ids) => serverService.summary(ids),
    serverTargets: (ids) => serverService.executionTargets(ids),
  });
  teamRunner = new PiTeamTurnRunner(adapter);

  const db = openDb(":memory:");
  const repo = new TeamRepo(db);
  for (const bot of [makeBot("coord", "小策"), makeBot("eng", "小码"), makeBot("rev", "小审")]) repo.saveBot(bot);
  repo.saveGroup({
    id: "g1", name: "研发群", description: "核心群", announcement: "遵循缓存稳定规则",
    memberBotIds: ["coord", "eng", "rev"], coordinatorBotId: "coord",
    mode: "execute", maxAutoRounds: 6, execution: { allowLocal: true, serverIds: ["srv-1"], strategy: "smart" },
    createdAt: 1, updatedAt: 1,
  });
  repo.saveMessage({ id: "hist-1", groupId: "g1", senderKind: "user", content: "历史消息内容用于验证跨成员公共前缀", mentions: [], createdAt: 10 });

  const base = `http://127.0.0.1:${server.port}`;
  const baseUrls: Record<string, string> = {
    "openai-compatible": `${base}/openai-compatible/v1`,
    codex: `${base}/codex/v1`,
    claude: `${base}/claude`,
    google: `${base}/google/v1beta`,
  };
  const modelConfigs = APIS.map((api) => ({
    id: `team-${api}/m`, provider: `team-${api}`, model: "m", enabled: true, updatedAt: 1,
    config: { apiType: api, baseUrl: baseUrls[api], thinking: "none" as const, autoMetadata: false, contextWindow: 128000, maxTokens: 4096, input: ["text" as const], output: ["text" as const] },
  }));

  const service = new TeamService({
    repo, runner: teamRunner, send: () => {}, servers: () => serverService.registry.list(),
    workspacePath: () => process.cwd(), modelConfigs: () => modelConfigs, canChat: () => true, concurrency: () => 2,
  });

  try {
    await adapter.configureModels(modelConfigs);
    for (const api of APIS) await adapter.setSecret(`model.apiKey:team-${api}`, "local-test-only");

    for (const api of APIS) {
      serverService.registry.update("srv-1", { status: "offline" });
      const mainSessionId = `main-${api}`;
      await adapter.run(mainSessionId, "MAIN_CHAT_TURN_1", { cwd: process.cwd(), model: `team-${api}/m`, permissionMode: "full", serverIds: ["srv-1"] }, () => {});
      await adapter.disposeSession(mainSessionId);

      const messageId = crypto.randomUUID();
      await service.handle({
        type: "team.message.send", requestId: crypto.randomUUID(), groupId: "g1", messageId,
        content: `实现并验收缓存修复_${api}`, mentions: [{ kind: "bot", targetId: "coord", label: "小策" }],
        defaults: { model: `team-${api}/m`, permissionMode: "full" },
      });
      await until(() => {
        const latest = repo.listRuns<TeamRunRecord>(20).find((item) => item.triggerMessageId === messageId);
        return latest?.status === "completed";
      }, `team run for ${api}`);

      // 团队跑完后，所有隔离会话必须已从内存中释放。
      expect(adapter.getSessions().length).toBe(0);

      // 主会话在服务器 status 已翻转为 ready 后重建，head 必须与第 1 轮字节一致。
      await adapter.run(mainSessionId, "MAIN_CHAT_TURN_2", { cwd: process.cwd(), model: `team-${api}/m`, permissionMode: "full", serverIds: ["srv-1"] }, () => {});
      await adapter.disposeSession(mainSessionId);

      const mainReqs = mainCaptured.get(api) ?? [];
      expect(mainReqs).toHaveLength(2);
      expect({ api, mainHead: promptHead(api, mainReqs[1]!.body) }).toEqual({ api, mainHead: promptHead(api, mainReqs[0]!.body) });

      const reqs = teamCaptured.get(api) ?? [];
      // plan(2) + work(1) + verify(2) + summary(1) = 6 次模型请求。
      expect({ api, count: reqs.length }).toEqual({ api, count: 6 });

      const baselineHead = promptHead(api, reqs[0]!.body);
      for (const req of reqs.slice(1)) {
        // 关键断言：plan / work / verify / summary 跨步骤且中途服务器状态翻转后，tools + system 必须完全字节一致。
        expect({ api, head: promptHead(api, req.body) }).toEqual({ api, head: baselineHead });
      }

      if (api === "codex") {
        // OpenAI Responses / Codex 跨全部步骤复用群级 prompt_cache_key。
        expect(reqs.map((req) => req.body.prompt_cache_key)).toEqual(reqs.map(() => "team:g1"));
      }
      if (api === "claude") {
        // Anthropic 每步都保留 cache_control，使后续步骤可 Cache Read 复用前步缓存。
        for (const req of reqs) expect(JSON.stringify(req.body.system)).toContain("cache_control");
      }

      // 同一次 run 中所有步骤的首条用户消息在 <team-role 之前共享完全一致的公共前缀，且不含实时服务器 status。
      const sharedPrefixes = reqs.map((req) => {
        const text = firstUserText(api, req.body);
        expect(text).not.toContain("last known status:");
        const roleIdx = text.indexOf("<team-role");
        expect(roleIdx).toBeGreaterThan(0);
        return text.slice(0, roleIdx);
      });
      for (const prefix of sharedPrefixes.slice(1)) {
        expect({ api, prefix }).toEqual({ api, prefix: sharedPrefixes[0] });
      }
    }
  } finally {
    await adapter.invalidateSessions();
    closeDb(db);
    serverService.dispose();
    server.stop(true);
  }
}, 45000);
