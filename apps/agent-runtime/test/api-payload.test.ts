import { describe, expect, test } from "bun:test";
import { VERTEX_AI_DEFAULT_BASE_URL, vertexProjectBaseUrl } from "@qone/protocol";
import { normalizeContext, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";
import { createConfiguredModelStream } from "../src/pi-provider-stream.js";
import { PiAdapter } from "../src/pi-adapter.js";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const context = normalizeContext({
  messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
});

function makeModel(api: Api, overrides: Partial<Model<Api>> = {}): Model<Api> {
  return {
    id: "test-model",
    name: "Test model",
    api,
    provider: "test-provider",
    baseUrl: "https://provider.example.test/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 32_768,
    ...overrides,
  } as Model<Api>;
}

async function capturePayload(invoke: (options: SimpleStreamOptions) => unknown, reasoning: SimpleStreamOptions["reasoning"] = "high"): Promise<Record<string, any>> {
  let resolvePayload!: (payload: Record<string, any>) => void;
  let rejectPayload!: (error: Error) => void;
  const payload = new Promise<Record<string, any>>((resolve, reject) => {
    resolvePayload = resolve;
    rejectPayload = reject;
  });
  const stream = invoke({
    apiKey: "test-key",
    maxTokens: 4096,
    reasoning,
    onPayload: (value) => {
      resolvePayload(value as Record<string, any>);
      throw new Error("payload captured");
    },
  });
  const result = (stream as { result?: () => Promise<unknown> } | undefined)?.result;
  if (result) void result.call(stream).catch((error) => rejectPayload(error instanceof Error ? error : new Error(String(error))));
  return await Promise.race([
    payload,
    new Promise<Record<string, any>>((_, reject) => setTimeout(() => reject(new Error("timed out capturing provider payload")), 2_000)),
  ]);
}

describe("Pi provider wire payloads", () => {
  test("Vertex streams through Express, global and regional project endpoints using the stored key and inline media", async () => {
    const requests: Array<{ url: URL; key: string | null; authorization: string | null; body: any }> = [];
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      requests.push({ url: new URL(request.url), key: request.headers.get("x-goog-api-key"), authorization: request.headers.get("authorization"), body: await request.json() });
      const chunk = { candidates: [{ content: { role: "model", parts: [{ text: "Vertex reply" }] }, finishReason: "STOP" }] };
      return new Response(`data: ${JSON.stringify(chunk)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    } });
    const directory = await mkdtemp(join(tmpdir(), "qone-vertex-"));
    const deltas: string[] = [];
    const adapter = new PiAdapter((event) => {
      if (event.type === "message.delta") deltas.push((event.payload as { delta: string }).delta);
    });
    try {
      const path = join(directory, "sample.wav");
      const bytes = Buffer.from("local audio bytes");
      await writeFile(path, bytes);
      const provider = "vertex-test";
      const model = "gemini-2.5-flash";
      const id = `${provider}/${model}`;
      const suffix = `/publishers/google/models/${model}:streamGenerateContent`;
      await adapter.setSecret(`model.apiKey:${provider}`, "test-vertex-key");
      const endpoints = [VERTEX_AI_DEFAULT_BASE_URL, ...["global", "asia-northeast1"].map((region) => vertexProjectBaseUrl("test-project", region))];
      for (const endpoint of endpoints) {
        const { pathname: prefix } = new URL(endpoint);
        await adapter.configureModels([{ provider, model, id, enabled: true, updatedAt: 1, config: {
          apiType: "google-vertex", baseUrl: `http://127.0.0.1:${server.port}${prefix}${suffix}?key=discard-this`,
          input: ["text", "audio"], output: ["text"],
          modelMetadata: { contextWindow: 128000, maxTokens: 4096, reasoning: false, input: ["text", "audio"], output: ["text"] },
        } }]);
        await adapter.run("vertex-session", "Listen", { cwd: directory, model: id, attachments: [
          { type: "file", name: "sample.wav", mimeType: "audio/wav", localPath: path, data: "" },
        ] }, () => {});
        expect(deltas.splice(0).join("")).toBe("Vertex reply");
        await adapter.disposeSession("vertex-session");
        const received = requests.at(-1)!;
        expect(received.url.pathname).toBe(`${prefix}${suffix}`);
        expect(received.url.searchParams.get("alt")).toBe("sse");
        expect(received.url.searchParams.has("key")).toBe(false);
        expect(received.key).toBe("test-vertex-key");
        expect(received.authorization).toBeNull();
        expect(received.body.contents[0].parts).toContainEqual({ inlineData: { mimeType: "audio/wav", data: bytes.toString("base64") } });
      }
      expect(requests).toHaveLength(endpoints.length);
    } finally {
      await adapter.disposeSession("vertex-session");
      server.stop(true);
      await rm(directory, { recursive: true, force: true });
    }
  });

  test("OpenAI-compatible completions uses max_completion_tokens and reasoning_effort", async () => {
    const model = makeModel("openai-completions", {
      compat: { maxTokensField: "max_completion_tokens", supportsReasoningEffort: true },
      thinkingLevelMap: { high: "high", off: "none" },
    });
    const payload = await capturePayload((options) => streamCompletions(model as never, context, options));
    expect(payload.max_completion_tokens).toBe(4096);
    expect(payload.max_tokens).toBeUndefined();
    expect(payload.reasoning_effort).toBe("high");
  });

  test("all configured transports preserve tool constraints unless the gateway rejects them", async () => {
    const streamConfiguredModel = createConfiguredModelStream();
    const surrogate = { pattern: String.raw`^[^\uD800-\uDFFF]*$` };
    const noNul = { pattern: String.raw`^[^\x00]*$` };
    const absolute = { pattern: String.raw`^\/` };
    const literalEscape = { type: "string", pattern: String.raw`^\\uD800$` };
    const emoji = { type: "string", pattern: "^😀$" };
    const parameters = {
      type: "object",
      properties: {
        snapshot_path: { type: "string", minLength: 1, allOf: [noNul, surrogate, absolute] },
        pattern: literalEscape,
        emoji,
      },
      examples: [{ pattern: surrogate.pattern }],
      additionalProperties: false,
    };
    const tools = [{ name: "close_binary", description: "Close binary", parameters }];
    const model = makeModel("openai-completions");
    const initial = normalizeContext({ messages: context.messages, tools });
    const payload = await capturePayload((options) => streamConfiguredModel(model, initial, options, []));
    expect(payload.tools[0].function.parameters).toEqual(parameters);

    const responses = await capturePayload((options) => streamConfiguredModel(makeModel("openai-responses"), initial, options, []));
    expect(responses.tools[0].parameters).toEqual(parameters);

    const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.signature`;
    const codex = makeModel("openai-codex-responses", { provider: "openai-codex", baseUrl: "https://chatgpt.com/backend-api" });
    const subscription = await capturePayload((options) => streamConfiguredModel(codex, initial, { ...options, apiKey: token }, []));
    expect(subscription.tools[0].parameters).toEqual(parameters);

    const claude = await capturePayload((options) => streamConfiguredModel(makeModel("anthropic-messages"), initial, options, []));
    expect(claude.tools[0].input_schema.properties).toEqual(parameters.properties);
    const gemini = await capturePayload((options) => streamConfiguredModel(makeModel("google-generative-ai", { id: "gemini-2.5-pro" }), initial, options, []));
    expect(gemini.config.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual(parameters);

    const added = normalizeContext({ systemPrompt: "Hello", messages: [
      ...context.messages, { role: "system", content: "", toolsAdded: tools, timestamp: 2 },
    ] });
    const incremental = makeModel("openai-completions", {
      compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolAdditions: true },
    });
    const delta = await capturePayload((options) => streamConfiguredModel(incremental, added, options, []));
    expect(delta.messages.find((message: { tools?: unknown }) => message.tools).tools[0].function.parameters)
      .toEqual(parameters);
    expect(parameters.properties.snapshot_path.allOf[1]).toEqual({ pattern: String.raw`^[^\uD800-\uDFFF]*$` });
  });

  test.each(["openai-completions", "openai-responses", "openai-codex-responses", "anthropic-messages", "google-generative-ai"] as const)(
    "%s downgrades only the rejected tool and stops after one retry", async (api) => {
      const numbers = { type: "array", items: { type: "number" }, uniqueItems: true, minItems: 1 };
      const parameters = { type: "object", properties: { numbers }, required: ["numbers"] };
      const sibling = { type: "object", properties: { label: { type: "string", minLength: 4 } }, required: ["label"] };
      const transcript = normalizeContext({ messages: context.messages, tools: [
        { name: "broken", description: "Broken", parameters }, { name: "healthy", description: "Healthy", parameters: sibling },
      ] });
      const seen: Array<Record<string, unknown>> = [];
      const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
        const body = (request.headers.get("content-encoding") === "zstd"
          ? JSON.parse(new TextDecoder().decode(Bun.zstdDecompressSync(await request.bytes())))
          : await request.json()) as Record<string, any>;
        const declarations = api === "google-generative-ai" ? body.tools[0].functionDeclarations : body.tools;
        const schema = Object.fromEntries((declarations as Record<string, any>[]).map((tool) => {
          const fn = tool.function ?? tool;
          return [fn.name, fn.parameters ?? fn.input_schema ?? fn.parametersJsonSchema];
        }));
        seen.push(schema);
        // A second explicit schema error must not trigger a third request.
        const keyword = seen.length === 1 ? "uniqueItems" : "minItems";
        const message = api === "google-generative-ai"
          ? `GenerateContentRequest.tools[0].function_declarations[0].parameters_json_schema: '${keyword}' is not supported`
          : `Invalid schema for function 'broken': '${keyword}' is not permitted`;
        return Response.json({ error: { message, type: "invalid_request_error", code: 400, status: "INVALID_ARGUMENT" } }, { status: 400 });
      } });
      try {
        const model = makeModel(api, { baseUrl: `http://127.0.0.1:${server.port}/v1`, ...(api === "google-generative-ai" ? { id: "gemini-2.5-pro" } : {}) });
        const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.signature`;
        const stream = createConfiguredModelStream()(model, transcript, { apiKey: api === "openai-codex-responses" ? token : "local-only", transport: "sse", maxRetries: 0 }, []);
        const result = await stream.result();
        expect(result.stopReason).toBe("error");
        expect(result.errorMessage).toContain("minItems");
        expect(seen).toHaveLength(2);
        expect(seen[0]!.broken).toEqual(parameters);
        expect(seen[0]!.healthy).toEqual(sibling);
        expect(seen[1]!.healthy).toEqual(sibling);
        expect(seen[1]!.broken).toEqual({ ...parameters, properties: { numbers: { type: "array", items: { type: "number" }, minItems: 1 } } });
        expect(parameters.properties.numbers.uniqueItems).toBe(true);
      } finally { server.stop(true); }
    },
  );

  test("repairs identical rejected regex pattern across all sibling tools in a single retry without harming healthy patterns", async () => {
    const badPattern = String.raw`^[^\uD800-\uDFFF]*$`;
    const makeBadTool = (name: string) => ({
      name,
      description: name,
      parameters: {
        type: "object",
        properties: { path: { type: "string", minLength: 1, pattern: badPattern } },
        required: ["path"],
      },
    });
    const healthy = {
      name: "healthy_tool",
      description: "healthy",
      parameters: {
        type: "object",
        properties: { label: { type: "string", pattern: "^[a-z]+$" } },
        required: ["label"],
      },
    };
    const transcript = normalizeContext({
      messages: context.messages,
      tools: [makeBadTool("mcp_mcp-rea_open_binary"), makeBadTool("mcp_mcp-rea_extract_artifact"), healthy],
    });
    let calls = 0;
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      async fetch(request) {
        calls++;
        const body = await request.json() as { tools?: Array<{ name?: string; parameters?: unknown }> };
        for (let i = 0; i < (body.tools?.length ?? 0); i++) {
          const t = body.tools![i]!;
          if (JSON.stringify(t.parameters).includes(JSON.stringify(badPattern))) {
            return Response.json({
              message: `Invalid schema for function '${t.name}': '${badPattern}' is not a 'regex'.`,
              type: "invalid_request_error",
              param: `tools[${i}].parameters`,
              code: "invalid_function_parameters",
            }, { status: 400 });
          }
        }
        // 验证健康工具的 pattern 未被误伤
        const healthySent = body.tools?.find((t) => t.name === "healthy_tool");
        expect(healthySent?.parameters).toEqual(healthy.parameters);
        const events = [
          { type: "response.created", response: { id: "resp_1", status: "in_progress" } },
          { type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } },
          { type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "ok" },
          { type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_1", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
          { type: "response.completed", response: { id: "resp_1", status: "completed", usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        return new Response(events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
          headers: { "Content-Type": "text/event-stream" },
        });
      },
    });
    try {
      const run = createConfiguredModelStream();
      const model = makeModel("openai-responses", { baseUrl: `http://127.0.0.1:${server.port}/v1` });
      const firstResult = await run(model, transcript, { apiKey: "local-only", transport: "sse", maxRetries: 0 }, []).result();
      expect(firstResult.stopReason).toBe("stop");
      expect(calls).toBe(2);
      // 第二轮应复用已学习的全部修复，0 次 400
      const secondResult = await run(model, transcript, { apiKey: "local-only", transport: "sse", maxRetries: 0 }, []).result();
      expect(secondResult.stopReason).toBe("stop");
      expect(calls).toBe(3);
    } finally {
      server.stop(true);
    }
  });

  test("native schema conversion still applies before gateway recovery", async () => {
    const run = createConfiguredModelStream();
    const input = normalizeContext({ messages: context.messages, tools: [{
      name: "typed", description: "Typed", parameters: {
        type: "object", properties: { mode: { type: "string", const: "read" } }, anyOf: [{ required: ["mode"] }],
      },
    }] });
    const claude = await capturePayload((options) => run(makeModel("anthropic-messages"), input, options, []));
    expect(claude.tools[0].input_schema).toEqual({ type: "object", properties: { mode: { type: "string", const: "read" } }, required: [] });
    const gemini = await capturePayload((options) => run(makeModel("google-generative-ai", { id: "gemini-2.5-pro" }), input, options, []));
    expect(gemini.config.tools[0].functionDeclarations[0].parametersJsonSchema).toEqual({
      type: "object", properties: { mode: { type: "string", enum: ["read"] } }, anyOf: [{ required: ["mode"] }],
    });
  });

  test("public Responses uses max_output_tokens and reasoning effort plus summary", async () => {
    const model = makeModel("openai-responses", {
      compat: { supportsMaxOutputTokens: true },
      thinkingLevelMap: { high: "high", off: "none" },
    });
    const payload = await capturePayload((options) => streamResponses(model as never, context, options));
    expect(payload.max_output_tokens).toBe(4096);
    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("ChatGPT Codex omits the unsupported max_output_tokens field", async () => {
    const token = `header.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "acct" } })).toString("base64url")}.signature`;
    const model = makeModel("openai-codex-responses", {
      provider: "openai-codex",
      baseUrl: "https://chatgpt.com/backend-api",
      compat: { supportsMaxOutputTokens: false },
      thinkingLevelMap: { high: "high", off: "none" },
    });
    const payload = await capturePayload((options) => streamCodex(model as never, context, { ...options, apiKey: token }));
    expect(payload.max_output_tokens).toBeUndefined();
    expect(payload.reasoning).toEqual({ effort: "high", summary: "auto" });
  });

  test("Claude adaptive and budget thinking use their native fields", async () => {
    const adaptive = makeModel("anthropic-messages", {
      id: "claude-sonnet-4-6",
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { high: "high", off: "none" },
    });
    const adaptivePayload = await capturePayload((options) => streamAnthropic(adaptive as never, context, options));
    expect(adaptivePayload.max_tokens).toBe(4096);
    expect(adaptivePayload.thinking).toMatchObject({ type: "adaptive" });
    expect(adaptivePayload.output_config).toEqual({ effort: "high" });

    const budget = makeModel("anthropic-messages", {
      id: "claude-3-7-sonnet",
      maxTokens: 32_768,
      thinkingLevelMap: { high: "high", off: "none" },
    });
    const budgetPayload = await capturePayload((options) => streamAnthropic(budget as never, context, options));
    expect(budgetPayload.thinking.type).toBe("enabled");
    expect(budgetPayload.thinking.budget_tokens).toBeGreaterThan(0);
    expect(budgetPayload.output_config).toBeUndefined();
  });

  test("Claude adaptive max reaches the native effort field", async () => {
    const model = makeModel("anthropic-messages", {
      id: "claude-sonnet-4-6",
      compat: { forceAdaptiveThinking: true },
      thinkingLevelMap: { max: "max" },
    });
    const payload = await capturePayload((options) => streamAnthropic(model as never, context, options), "max");
    expect(payload.thinking.type).toBe("adaptive");
    expect(payload.output_config).toEqual({ effort: "max" });
  });

  test("Gemini uses maxOutputTokens and thinkingConfig", async () => {
    const model = makeModel("google-generative-ai", {
      id: "gemini-2.5-pro",
      baseUrl: "https://generativelanguage.googleapis.com/v1beta",
      thinkingLevelMap: { high: "high", off: "none" },
    });
    const payload = await capturePayload((options) => streamGoogle(model as never, context, options));
    expect(payload.config.maxOutputTokens).toBe(4096);
    expect(payload.config.thinkingConfig.includeThoughts).toBe(true);
    expect(payload.config.thinkingConfig.thinkingBudget).toBeGreaterThan(0);
  });

  test("Gemini 3 uses native thinkingLevel instead of thinkingBudget", async () => {
    const model = makeModel("google-generative-ai", {
      id: "gemini-3.1-pro-preview",
      thinkingLevelMap: { off: null, minimal: null, low: "low", medium: "medium", high: "high" },
    });
    const payload = await capturePayload((options) => streamGoogle(model as never, context, options), "low");
    expect(payload.config.thinkingConfig.thinkingLevel).toBe("LOW");
    expect(payload.config.thinkingConfig.thinkingBudget).toBeUndefined();
  });
});
