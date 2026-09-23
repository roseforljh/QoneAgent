// Recognize the model family, independently of its version or provider profile name.
const brands = [
  ["deepseek", /\bdeep[\s_-]?seek|深度求索/i],
  ["gemini", /\bgemini/i],
  ["claude", /\bclaude|\banthropic/i],
  ["grok", /\bgrok|\bxai\b|\bx-ai\b/i],
  ["qwen", /\bqwen|\bqwq|通义千问|千问/i],
  ["kimi", /\bkimi|\bmoonshot|月之暗面/i],
  ["zhipu", /\b(?:chat)?glm|\bzhipu|智谱/i],
  ["meta", /\bllama|\bmeta\b/i],
  ["mistral", /\bmistral|\bmixtral|\bministral|\bcodestral|\bdevstral|\bmagistral|\bpixtral/i],
  ["minimax", /\bminimax|海螺/i],
  ["doubao", /\bdoubao|\bseed[\s_-]?(?:\d|oss)|豆包/i],
  ["hunyuan", /\bhunyuan|混元/i],
  ["gemma", /\bgemma/i],
  ["baidu", /\bernie|文心/i],
  ["yi", /\byi(?:[-\s_\d]|$)|零一万物/i],
  ["openai", /\b(?:chat[\s_-]?)?gpt|\bopenai|\bcodex|\bo[134](?:\b|[-_])/i],
] as const;

export type ModelBrand = (typeof brands)[number][0];

export function getModelBrand(modelName: string, label = ""): ModelBrand | undefined {
  // Ignore routing namespaces such as openai/claude-sonnet and custom provider IDs.
  for (const name of [modelName.split("/").at(-1) ?? "", label]) {
    const match = brands.find(([, pattern]) => pattern.test(name));
    if (match) return match[0];
  }
  return undefined;
}
