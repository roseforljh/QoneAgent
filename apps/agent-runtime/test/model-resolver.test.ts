import { describe, expect, test } from "bun:test";
import { decodeCommand, modelBaseUrl, modelListUrl, parseModelMetadataResponse } from "@qone/protocol";
import { ModelMetadataResolver } from "../src/model-resolver.js";

const baseConfig = (apiType: string, extra: Record<string, unknown> = {}) => ({
  apiType,
  baseUrl: "https://provider.example.test",
  autoMetadata: true,
  maxContext: 128_000,
  maxOutput: 8_192,
  thinking: "high",
  ...extra,
});

describe("model metadata resolver", () => {
  test("Pi catalog fills provider omissions before models.dev", async () => {
    const resolver = new ModelMetadataResolver({
      fetchImpl: async () => new Response(JSON.stringify({ openai: { models: { "gpt-4o": { limit: { context: 999_999, output: 99_999 } } } } })),
      providerModelsFetcher: async () => ({ data: [{ id: "gpt-4o" }] }),
    });
    const result = await resolver.resolve({ provider: "merchant", model: "gpt-4o", config: baseConfig("openai-compatible") });
    expect(result.sources.contextWindow).toBe("pi");
    expect(result.sources.maxTokens).toBe("pi");
  });

  test("saved fallback fields are not promoted to merchant priority", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const result = await resolver.resolve({ provider: "merchant", model: "unknown-custom-model", config: baseConfig("openai-compatible", {
      modelMetadata: { id: "unknown-custom-model", contextWindow: 48_000, maxTokens: 12_000 },
      metadataSources: { maxContext: "provider", maxOutput: "models.dev" },
    }) });
    expect(result.sources.contextWindow).toBe("provider");
    expect(result.sources.maxTokens).toBe("default");
    expect(result.metadata.maxTokens).toBeUndefined();
  });

  test("complete merchant metadata needs no models.dev request", async () => {
    let modelsDevCalls = 0;
    const resolver = new ModelMetadataResolver({
      fetchImpl: async () => { modelsDevCalls++; return new Response("{}"); },
      providerModelsFetcher: async () => ({ data: [{ id: "complete-custom-model", context_length: 48_000, max_output_tokens: 4_000, reasoning: false, modalities: { input: ["text", "image"], output: ["text"] } }] }),
    });
    const result = await resolver.resolve({ provider: "merchant", model: "complete-custom-model", config: baseConfig("openai-compatible") });
    expect(modelsDevCalls).toBe(0);
    expect(result.sources).toEqual({ contextWindow: "provider", maxTokens: "provider", reasoning: "provider", input: "provider", output: "provider" });
  });

  test("falls back promptly when models.dev ignores abort, then retries later", async () => {
    let calls = 0;
    const resolver = new ModelMetadataResolver({
      timeoutMs: 30,
      fetchImpl: async () => {
        calls++;
        if (calls === 1) return new Promise<Response>(() => {});
        return new Response(JSON.stringify({ catalog: { models: { "timeout-model": { limit: { output: 6_000 } } } } }));
      },
    });
    const input = { provider: "merchant", model: "timeout-model", config: baseConfig("openai-compatible", { modelMetadata: { contextWindow: 48_000 } }) };
    const first = await resolver.resolve(input);
    expect(first.sources.contextWindow).toBe("provider");
    expect(first.sources.maxTokens).toBe("default");
    const second = await resolver.resolve(input);
    expect(calls).toBe(2);
    expect(second.sources.maxTokens).toBe("models.dev");
    expect(second.maxTokens).toBe(6_000);
  });

  test("parses provider model limits, reasoning options and modalities", () => {
    const [model] = parseModelMetadataResponse({
      data: [{
        id: "models/demo",
        display_name: "Demo",
        context_length: 64_000,
        max_completion_tokens: 4_096,
        reasoning_options: [{ type: "effort", values: ["low", "high"], min: 1, max: 4 }],
        modalities: { input: ["text", "image", "pdf"], output: ["text"] },
        supported_parameters: ["reasoning_effort", "max_completion_tokens"],
      }],
    });
    expect(model).toEqual({
      id: "demo",
      label: "Demo",
      metadata: {
        id: "demo",
        label: "Demo",
        contextWindow: 64_000,
        maxTokens: 4_096,
        reasoning: true,
        reasoningOptions: [{ type: "effort", values: ["low", "high"], min: 1, max: 4 }],
        input: ["text", "image", "pdf"],
        output: ["text"],
        supportedParameters: ["reasoning_effort", "max_completion_tokens"],
      },
    });
  });

  test("uses provider metadata per field, then Pi, then models.dev", async () => {
    let providerCalls = 0;
    let modelsDevCalls = 0;
    const resolver = new ModelMetadataResolver({
      fetchImpl: async (url) => {
        modelsDevCalls++;
        expect(String(url)).toBe("https://models.dev/api.json");
        return new Response(JSON.stringify({ catalog: { models: {
          "unlisted-model": { id: "unlisted-model", limit: { context: 999_999, output: 7_777 }, reasoning: false },
        } } }));
      },
      providerModelsFetcher: async () => {
        providerCalls++;
        return { data: [{ id: "unlisted-model", context_length: 111_111, reasoning: true }] };
      },
    });
    const result = await resolver.resolve({
      provider: "merchant",
      model: "unlisted-model",
      apiKey: "key",
      config: baseConfig("openai-compatible"),
    });
    expect(providerCalls).toBe(1);
    expect(modelsDevCalls).toBe(1);
    expect(result.contextWindow).toBe(111_111);
    expect(result.maxTokens).toBe(7_777);
    expect(result.reasoning).toBe(true);
    expect(result.sources).toMatchObject({ contextWindow: "provider", maxTokens: "models.dev", reasoning: "provider" });
    expect(result.metadata.contextWindow).toBe(111_111);
    expect(result.metadata.maxTokens).toBe(7_777);
    expect(result.metadata.reasoning).toBe(true);
  });

  test("resolves supplied merchant metadata for settings without credentials or another merchant request", async () => {
    let devCalls = 0;
    const resolver = new ModelMetadataResolver({
      fetchImpl: async () => {
        devCalls++;
        return new Response(JSON.stringify({ catalog: { models: { "custom-model": { limit: { context: 96_000, output: 12_000 }, modalities: { output: ["text", "audio"] } } } } }));
      },
    });
    const result = await resolver.resolve({
      provider: "merchant",
      model: "custom-model",
      config: baseConfig("claude", { modelMetadata: { id: "custom-model", contextWindow: 48_000, reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "high"] }] } }),
    });
    expect(devCalls).toBe(1);
    expect(result.metadata.contextWindow).toBe(48_000);
    expect(result.metadata.maxTokens).toBe(12_000);
    expect(result.metadata.output).toEqual(["text", "audio"]);
    expect(result.thinkingLevelMap?.low).toBe("low");
    expect(result.sources).toMatchObject({ contextWindow: "provider", maxTokens: "models.dev", reasoning: "provider", output: "models.dev" });
  });

  test("validates batched settings metadata requests", () => {
    expect(decodeCommand(JSON.stringify({ type: "model.resolve-metadata", requestId: "r1", provider: "merchant", apiType: "google", baseUrl: "https://example.test", models: [{ id: "gemini-demo", metadata: { contextWindow: 123_456 } }] }))).toMatchObject({ type: "model.resolve-metadata", models: [{ id: "gemini-demo", metadata: { contextWindow: 123_456 } }] });
    expect(decodeCommand(JSON.stringify({ type: "model.resolve-metadata", requestId: "r2", provider: "merchant", apiType: "google", baseUrl: "https://example.test", models: [] }))).toBeNull();
  });

  test("manual limit overrides remain explicit over automatic sources", async () => {
    const resolver = new ModelMetadataResolver({
      disableModelsDev: true,
      providerModelsFetcher: async () => ({ data: [{ id: "manual-model", context_length: 100, max_tokens: 200 }] }),
    });
    const result = await resolver.resolve({
      provider: "merchant",
      model: "manual-model",
      apiKey: "key",
      config: baseConfig("openai-compatible", {
        maxContext: 300,
        maxOutput: 400,
        metadataOverrides: { maxContext: true, maxOutput: true },
      }),
    });
    expect(result.contextWindow).toBe(300);
    expect(result.maxTokens).toBe(400);
    expect(result.sources.contextWindow).toBe("config");
    expect(result.sources.maxTokens).toBe("config");
  });

  test("maps all four UI API types to Pi APIs and endpoint semantics", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const cases = [
      ["openai-compatible", "openai-completions", "https://provider.example.test/v1"],
      ["codex", "openai-responses", "https://provider.example.test/v1"],
      // Anthropic's SDK appends /v1/messages itself, so the runtime base is
      // the host/prefix even when the user enters a copied /v1 URL.
      ["claude", "anthropic-messages", "https://provider.example.test"],
      ["google", "google-generative-ai", "https://provider.example.test/v1beta"],
    ] as const;
    for (const [apiType, api, baseUrl] of cases) {
      const result = await resolver.resolve({
        provider: "merchant",
        model: `custom-${apiType}`,
        config: baseConfig(apiType, { baseUrl }),
      });
      expect(result.api).toBe(api);
      expect(result.baseUrl).toBe(baseUrl);
    }
    const subscription = await resolver.resolve({
      provider: "openai-codex",
      model: "gpt-5.5-codex",
      config: baseConfig("codex", { baseUrl: "https://chatgpt.com/backend-api" }),
    });
    expect(subscription.api).toBe("openai-codex-responses");
    expect(subscription.baseUrl).toBe("https://chatgpt.com/backend-api");
  });

  test("separates private Codex runtime URLs from catalog URLs with query parameters", async () => {
    let seen: { baseUrl: string; catalogBaseUrl: string } | undefined;
    const resolver = new ModelMetadataResolver({
      disableModelsDev: true,
      providerModelsFetcher: async (input) => {
        seen = { baseUrl: input.baseUrl, catalogBaseUrl: input.catalogBaseUrl };
        return [];
      },
    });
    const result = await resolver.resolve({
      provider: "merchant",
      model: "custom-codex",
      config: baseConfig("codex", { baseUrl: "https://chatgpt.com/backend-api?tenant=demo" }),
    });
    expect(result.api).toBe("openai-codex-responses");
    expect(result.baseUrl).toBe("https://chatgpt.com/backend-api");
    expect(seen).toEqual({
      baseUrl: "https://chatgpt.com/backend-api",
      catalogBaseUrl: "https://chatgpt.com/backend-api?tenant=demo",
    });
  });

  test("keeps query parameters for catalogs but removes them from SDK string-join runtime URLs", async () => {
    let seen: { baseUrl: string; catalogBaseUrl: string } | undefined;
    const resolver = new ModelMetadataResolver({
      disableModelsDev: true,
      providerModelsFetcher: async (input) => {
        seen = { baseUrl: input.baseUrl, catalogBaseUrl: input.catalogBaseUrl };
        return [];
      },
    });
    const result = await resolver.resolve({
      provider: "merchant",
      model: "custom-openai",
      config: baseConfig("openai-compatible", { baseUrl: "https://gateway.example.test/v1?tenant=demo" }),
    });
    expect(result.baseUrl).toBe("https://gateway.example.test/v1");
    expect(seen).toEqual({
      baseUrl: "https://gateway.example.test/v1",
      catalogBaseUrl: "https://gateway.example.test/v1?tenant=demo",
    });
  });

  test("uses Pi model thinking maps and API-specific compatibility", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const openai = await resolver.resolve({ provider: "proxy", model: "gpt-5.5", config: baseConfig("openai-compatible") });
    expect(openai.thinkingLevelMap?.low).toBe("low");
    expect(openai.compat?.supportsReasoningEffort).toBe(true);
    expect(openai.compat?.thinkingFormat).toBeUndefined();

    const deepseek = await resolver.resolve({ provider: "proxy", model: "deepseek-flash", config: baseConfig("openai-compatible") });
    expect(deepseek.compat?.thinkingFormat).toBe("deepseek");
    expect(deepseek.compat?.supportsReasoningEffort).toBe(false);

    const claude = await resolver.resolve({ provider: "proxy", model: "claude-fable-5", config: baseConfig("claude") });
    expect(claude.compat?.forceAdaptiveThinking).toBe(true);

    const google = await resolver.resolve({ provider: "proxy", model: "gemini-2.5-pro", config: baseConfig("google") });
    expect(google.maxTokens).toBeGreaterThan(8_192);
  });

  test("does not leak a gateway compat record into a generic endpoint", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const glm = await resolver.resolve({
      provider: "generic-proxy",
      model: "glm-5",
      config: baseConfig("openai-compatible", { baseUrl: "https://gateway.example.test/v1" }),
    });
    // GLM is inferred as z.ai by model family, while the Qwen-token-plan
    // catalog entry that happens to share the name must not be copied in.
    expect(glm.compat?.thinkingFormat).toBe("zai");
    expect(glm.compat?.thinkingFormat).not.toBe("qwen");
    expect(glm.compat?.supportsReasoningEffort).toBe(false);
  });

  test("lets a confirmed endpoint override a conflicting model-family hint", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const model = await resolver.resolve({
      provider: "zai",
      model: "deepseek-chat",
      config: baseConfig("openai-compatible", { baseUrl: "https://api.z.ai/v1" }),
    });
    expect(model.compat?.thinkingFormat).toBe("zai");
  });

  test("selects the subscription Responses catalog entry for ChatGPT backend URLs", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const model = await resolver.resolve({
      provider: "openai-codex",
      model: "gpt-5.5",
      config: baseConfig("codex", { baseUrl: "https://chatgpt.com/backend-api" }),
    });
    expect(model.api).toBe("openai-codex-responses");
    expect(model.compat?.supportsMaxOutputTokens).toBe(false);
    expect(model.thinkingLevelMap?.minimal).toBe("low");
  });

  test("uses provider-declared reasoning formats only when the API advertises them", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const qwen = await resolver.resolve({
      provider: "merchant",
      model: "qwen-custom",
      config: baseConfig("openai-compatible", {
        baseUrl: "https://gateway.example.test/v1",
        modelMetadata: {
          id: "qwen-custom",
          reasoning: true,
          reasoning_options: [{ type: "toggle" }],
          supported_parameters: ["max_tokens"],
        },
      }),
    });
    expect(qwen.compat?.thinkingFormat).toBe("qwen");
    // Qwen's wire format uses enable_thinking rather than reasoning_effort.
    // Keep an explicit false override so Pi's URL auto-detection cannot add
    // an unsupported reasoning_effort field for a generic gateway URL.
    expect(qwen.compat?.supportsReasoningEffort).toBe(false);
    expect(qwen.compat?.maxTokensField).toBe("max_tokens");

    const deepseek = await resolver.resolve({
      provider: "merchant",
      model: "deepseek-custom",
      config: baseConfig("openai-compatible", {
        baseUrl: "https://gateway.example.test/v1",
        modelMetadata: {
          id: "deepseek-custom",
          reasoning: true,
          supported_parameters: ["thinking", "reasoning_effort", "max_tokens"],
        },
      }),
    });
    expect(deepseek.compat?.thinkingFormat).toBe("deepseek");
    expect(deepseek.compat?.supportsReasoningEffort).toBe(true);

    const genericEffort = await resolver.resolve({
      provider: "merchant",
      model: "vendor-reasoner",
      config: baseConfig("openai-compatible", {
        modelMetadata: {
          id: "vendor-reasoner",
          reasoning: true,
          reasoning_options: [{ type: "effort", values: ["low", "high"] }],
          supported_parameters: ["reasoning_effort", "max_completion_tokens"],
        },
      }),
    });
    expect(genericEffort.compat?.supportsReasoningEffort).toBe(true);
    expect(genericEffort.compat?.maxTokensField).toBe("max_completion_tokens");

    const genericToggle = await resolver.resolve({
      provider: "merchant",
      model: "vendor-toggle",
      config: baseConfig("openai-compatible", {
        modelMetadata: {
          id: "vendor-toggle",
          reasoning: true,
          supported_parameters: ["enable_thinking", "max_tokens"],
        },
      }),
    });
    expect(genericToggle.compat?.thinkingFormat).toBe("qwen");
    expect(genericToggle.compat?.supportsReasoningEffort).toBe(false);
  });

  test("keeps a live provider catalog ahead of stale saved metadata", async () => {
    const resolver = new ModelMetadataResolver({
      disableModelsDev: true,
      providerModelsFetcher: async () => ({ data: [{
        id: "stale-check",
        context_length: 200_000,
        max_tokens: 16_384,
        reasoning: false,
      }] }),
    });
    const result = await resolver.resolve({
      provider: "merchant",
      model: "stale-check",
      config: baseConfig("openai-compatible", {
        modelMetadata: { id: "stale-check", contextWindow: 1_000, maxTokens: 2_000, reasoning: true },
      }),
    });
    expect(result.contextWindow).toBe(200_000);
    expect(result.maxTokens).toBe(16_384);
    expect(result.reasoning).toBe(false);
  });

  test("treats disabled thinking values as a real off override", async () => {
    const resolver = new ModelMetadataResolver({
      disableModelsDev: true,
      providerModelsFetcher: async () => ({ data: [{ id: "reasoning-model", reasoning: true }] }),
    });
    const result = await resolver.resolve({
      provider: "merchant",
      model: "reasoning-model",
      config: baseConfig("openai-compatible", { thinking: "disabled", autoMetadata: false }),
    });
    expect(result.reasoning).toBe(false);
    expect(result.thinkingLevelMap?.high).toBeNull();
  });

  test("maps provider budget parameters and common model namespaces", async () => {
    const resolver = new ModelMetadataResolver({ disableModelsDev: true });
    const qwen = await resolver.resolve({
      provider: "merchant",
      model: "Qwen/Qwen3-32B",
      config: baseConfig("openai-compatible", {
        modelMetadata: {
          id: "Qwen/Qwen3-32B",
          reasoning: true,
          supported_parameters: ["max_tokens", "enable_thinking", "thinking_budget"],
        },
      }),
    });
    expect(qwen.compat?.thinkingFormat).toBe("qwen");
    expect(qwen.compat?.thinkingTokenBudgetField).toBe("thinking_budget");

    const zai = await resolver.resolve({
      provider: "merchant",
      model: "glm-5",
      config: baseConfig("openai-compatible", {
        baseUrl: "https://api.z.ai/v1",
        modelMetadata: { id: "glm-5", reasoning: true, supported_parameters: ["thinking"] },
      }),
    });
    expect(zai.compat?.thinkingFormat).toBe("zai");
  });

  test("retries a provider catalog after a transient failure", async () => {
    let calls = 0;
    const resolver = new ModelMetadataResolver({
      disableModelsDev: true,
      providerModelsFetcher: async () => {
        calls++;
        if (calls === 1) throw new Error("temporary outage");
        return { data: [{ id: "retry-model", context_length: 222_222 }] };
      },
    });
    await resolver.resolve({ provider: "merchant", model: "retry-model", config: baseConfig("openai-compatible") });
    const result = await resolver.resolve({ provider: "merchant", model: "retry-model", config: baseConfig("openai-compatible") });
    expect(calls).toBe(2);
    expect(result.contextWindow).toBe(222_222);
  });

  test("normalizes bare hosts and complete endpoint URLs", () => {
    expect(modelBaseUrl("openai-compatible", "api.example.test")).toBe("https://api.example.test/v1");
    expect(modelBaseUrl("openai-compatible", "localhost:8080/v1/chat/completions")).toBe("http://localhost:8080/v1");
    expect(modelBaseUrl("claude", "api.anthropic.com")).toBe("https://api.anthropic.com");
    expect(modelBaseUrl("claude", "https://proxy.example.test/anthropic/v1/messages")).toBe("https://proxy.example.test/anthropic");
    expect(modelBaseUrl("google", "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:generateContent")).toBe("https://generativelanguage.googleapis.com/v1beta");
    expect(modelListUrl("openai-compatible", "https://api.example.test/v1?tenant=demo")).toBe("https://api.example.test/v1/models?tenant=demo");
    expect(modelListUrl("claude", "https://api.anthropic.com")).toBe("https://api.anthropic.com/v1/models");
  });
});
