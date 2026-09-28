import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import alibaba from "@lobehub/icons-static-svg/icons/alibaba-color.svg";
import kimi from "@lobehub/icons-static-svg/icons/kimi-color.svg";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import groq from "@lobehub/icons-static-svg/icons/groq.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg";
import doubao from "@lobehub/icons-static-svg/icons/doubao-color.svg";
import hunyuan from "@lobehub/icons-static-svg/icons/hunyuan-color.svg";
import baidu from "@lobehub/icons-static-svg/icons/baidu-color.svg";
import siliconcloud from "@lobehub/icons-static-svg/icons/siliconcloud-color.svg";

export type ProviderBrand =
  | "openai" | "gemini" | "claude" | "qwen" | "alibaba" | "kimi" | "zhipu" | "minimax"
  | "deepseek" | "groq" | "mistral" | "meta" | "doubao" | "hunyuan" | "baidu" | "siliconcloud";

export const providerBrandIcons: Record<ProviderBrand, string> = {
  openai, gemini, claude, qwen, alibaba, kimi, zhipu, minimax, deepseek,
  groq, mistral, meta, doubao, hunyuan, baidu, siliconcloud,
};

const brandRules: { brand: ProviderBrand; name: string[]; host: string[] }[] = [
  { brand: "openai", name: ["openai", "chatgpt", "gpt"], host: ["openai.com", "chatgpt.com"] },
  { brand: "gemini", name: ["gemini", "google ai", "vertex ai", "谷歌", "Google"], host: ["googleapis.com", "ai.google", "aistudio.google.com"] },
  { brand: "claude", name: ["anthropic", "claude"], host: ["anthropic.com"] },
  { brand: "qwen", name: ["qwen", "通义", "千问"], host: ["dashscope.aliyuncs.com"] },
  { brand: "alibaba", name: ["alibaba", "阿里", "阿里云", "百炼", "aliyun"], host: ["aliyun.com", "alibabacloud.com"] },
  { brand: "kimi", name: ["kimi", "moonshot", "月之暗面"], host: ["moonshot.cn", "moonshot.ai"] },
  { brand: "zhipu", name: ["zhipu", "智谱", "智普", "glm"], host: ["bigmodel.cn", "zhipuai.cn"] },
  { brand: "minimax", name: ["minimax", "mini max"], host: ["minimaxi.com"] },
  { brand: "deepseek", name: ["deepseek"], host: ["deepseek.com"] },
  { brand: "groq", name: ["groq"], host: ["groq.com"] },
  { brand: "mistral", name: ["mistral", "codestral", "魔搭"], host: ["mistral.ai"] },
  { brand: "meta", name: ["meta", "llama"], host: ["meta.ai"] },
  { brand: "doubao", name: ["doubao", "豆包", "火山引擎", "volcengine"], host: ["volcengine.com"] },
  { brand: "hunyuan", name: ["hunyuan", "混元", "腾讯"], host: ["hunyuan.tencent.com"] },
  { brand: "baidu", name: ["baidu", "百度", "文心", "ernie"], host: ["baidubce.com", "wenxin.baidu.com"] },
  { brand: "siliconcloud", name: ["siliconflow", "硅基流动"], host: ["siliconflow.cn"] },
];

function hasName(name: string, value: string) {
  if (/[^\x00-\x7f]/.test(value)) return name.includes(value.toLowerCase());
  return new RegExp(`(?:^|[^a-z0-9])${value.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^a-z0-9])`).test(name);
}

export function getProviderBrand(name: string, baseUrl: string): ProviderBrand | undefined {
  const normalizedName = name.trim().toLowerCase();
  let hostname = "";
  try {
    hostname = new URL(/^https?:\/\//i.test(baseUrl.trim()) ? baseUrl.trim() : `https://${baseUrl.trim()}`).hostname.toLowerCase();
  } catch { /* name matching still works for incomplete addresses */ }
  return brandRules.find((rule) => rule.name.some((value) => hasName(normalizedName, value)) || rule.host.some((value) => hostname === value || hostname.endsWith(`.${value}`)))?.brand;
}
