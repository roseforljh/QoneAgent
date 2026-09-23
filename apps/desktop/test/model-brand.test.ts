import { expect, test } from "bun:test";
import { getModelBrand } from "../src/lib/model-brand";

test("recognizes model families without enumerating versions", () => {
  const cases = {
    "Gemini-2.5-Pro": "gemini", "google/gemini-3-flash": "gemini",
    "anthropic/Claude-Sonnet-4.5": "claude", "CLAUDE-opus": "claude",
    "gpt-6-astra": "openai", "ChatGPT-4o": "openai", "o3-mini": "openai",
    "o1": "openai", "gpt-oss-120b": "openai", "codex-mini": "openai",
    "DeepSeek-V4-Pro": "deepseek", "deepseek-ai/DeepSeek-R1-Distill-Qwen-32B": "deepseek",
    "grok-4.5": "grok", "Qwen3-235B": "qwen", "QwQ-32B": "qwen",
    "Kimi-K2": "kimi", "moonshot-v1-128k": "kimi", "GLM-4.5": "zhipu",
    "meta-llama/Llama-4": "meta", "Mistral-Large": "mistral", "codestral-latest": "mistral",
    "MiniMax-M2": "minimax", "doubao-seed-1.6": "doubao", "Seed-OSS-36B": "doubao",
    "hunyuan-t1": "hunyuan", "Gemma-3-27b": "gemma", "ERNIE-4.5": "baidu",
    "Yi-34B": "yi", "通义千问": "qwen", "智谱清言": "zhipu", "豆包": "doubao",
  };
  for (const [name, brand] of Object.entries(cases)) expect(getModelBrand(name)).toBe(brand);
});

test("uses the actual model before aliases and ignores gateway namespaces", () => {
  expect(getModelBrand("openai/claude-sonnet-4", "GPT alternative")).toBe("claude");
  expect(getModelBrand("claude-proxy/gpt-5")).toBe("openai");
  expect(getModelBrand("deepseek-v4", "我的常用模型")).toBe("deepseek");
  expect(getModelBrand("custom-123", "Gemini Pro")).toBe("gemini");
  expect(getModelBrand("gpt-provider/custom-123")).toBeUndefined();
});

test("unknown and empty models use the generic icon", () => {
  for (const name of ["", "custom-model", "my-model", "enjoying", "metaphor", "o100", "notgpt"])
    expect(getModelBrand(name)).toBeUndefined();
});
