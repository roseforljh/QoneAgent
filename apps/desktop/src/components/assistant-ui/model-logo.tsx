import type { CSSProperties } from "react";
import { BotIcon } from "lucide-react";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg";
import gemini from "@lobehub/icons-static-svg/icons/gemini-color.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import grok from "@lobehub/icons-static-svg/icons/grok.svg";
import qwen from "@lobehub/icons-static-svg/icons/qwen-color.svg";
import kimi from "@lobehub/icons-static-svg/icons/moonshot.svg";
import zhipu from "@lobehub/icons-static-svg/icons/zhipu-color.svg";
import meta from "@lobehub/icons-static-svg/icons/meta-color.svg";
import mistral from "@lobehub/icons-static-svg/icons/mistral-color.svg";
import minimax from "@lobehub/icons-static-svg/icons/minimax-color.svg";
import doubao from "@lobehub/icons-static-svg/icons/doubao-color.svg";
import hunyuan from "@lobehub/icons-static-svg/icons/hunyuan-color.svg";
import gemma from "@lobehub/icons-static-svg/icons/gemma-color.svg";
import baidu from "@lobehub/icons-static-svg/icons/baidu-color.svg";
import yi from "@lobehub/icons-static-svg/icons/yi-color.svg";
import { getModelBrand, type ModelBrand } from "../../lib/model-brand";
import "./model-logo.css";

const icons: Record<ModelBrand, string> = {
  openai, claude, gemini, deepseek, grok, qwen, kimi, zhipu,
  meta, mistral, minimax, doubao, hunyuan, gemma, baidu, yi,
};
const monochrome = new Set<ModelBrand>(["openai", "grok", "kimi"]);

export function ModelLogo({ modelName, label, size = 20 }: {
  modelName: string;
  label?: string;
  size?: number;
}) {
  const brand = getModelBrand(modelName, label);
  const style: CSSProperties = { width: size, height: size };
  if (!brand) return <BotIcon className="q-model-logo" style={style} aria-hidden="true" />;
  // Masks let monochrome logos inherit the foreground in both light and dark themes.
  if (monochrome.has(brand)) {
    return <span className="q-model-logo q-model-logo-mono" data-brand={brand} aria-hidden="true" style={{ ...style, maskImage: `url("${icons[brand]}")`, WebkitMaskImage: `url("${icons[brand]}")` }} />;
  }
  return <img className="q-model-logo" data-brand={brand} src={icons[brand]} style={style} alt="" aria-hidden="true" draggable={false} />;
}
