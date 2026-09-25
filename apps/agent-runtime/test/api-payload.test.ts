import { describe, expect, test } from "bun:test";
import { normalizeContext, type Api, type Model, type SimpleStreamOptions } from "@earendil-works/pi-ai";
import { streamSimple as streamAnthropic } from "@earendil-works/pi-ai/api/anthropic-messages";
import { streamSimple as streamCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import { streamSimple as streamCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { streamSimple as streamResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as streamGoogle } from "@earendil-works/pi-ai/api/google-generative-ai";

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
