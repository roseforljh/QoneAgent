import { expect, test } from "bun:test";
import { getProviderBrand } from "../src/components/settings/provider-brand";

test("recognizes built-in mainstream provider brands", () => {
  const cases = {
    Gemini: "gemini", GPT: "openai", Claude: "claude", 阿里云: "alibaba", Qwen: "qwen", Kimi: "kimi",
    智谱: "zhipu", 智普: "zhipu", MiniMax: "minimax", DeepSeek: "deepseek", Groq: "groq", Mistral: "mistral",
    豆包: "doubao", 混元: "hunyuan", 百度: "baidu", "硅基流动": "siliconcloud",
  } as const;
  for (const [name, brand] of Object.entries(cases)) expect(getProviderBrand(name, "")).toBe(brand);
});

test("uses the API host when the provider name is generic", () => {
  expect(getProviderBrand("自定义商家", "https://generativelanguage.googleapis.com/v1")).toBe("gemini");
  expect(getProviderBrand("自定义商家", "https://api.deepseek.com/v1")).toBe("deepseek");
  expect(getProviderBrand("自定义商家", "https://api.example.com/v1")).toBeUndefined();
});
