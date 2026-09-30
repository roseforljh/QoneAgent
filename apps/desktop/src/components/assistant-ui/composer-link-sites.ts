import cloudflare from "@lobehub/icons-static-svg/icons/cloudflare-color.svg";
import bilibili from "@lobehub/icons-static-svg/icons/bilibili-color.svg";
import huggingface from "@lobehub/icons-static-svg/icons/huggingface-color.svg";
import vercel from "@lobehub/icons-static-svg/icons/vercel.svg";
import openai from "@lobehub/icons-static-svg/icons/openai.svg";
import claude from "@lobehub/icons-static-svg/icons/claude-color.svg";
import deepseek from "@lobehub/icons-static-svg/icons/deepseek-color.svg";
import google from "@lobehub/icons-static-svg/icons/google-color.svg";
import reddit from "../../assets/codex-icons/reddit-regular-20.svg";
import x from "../../assets/website-icons/x.svg";
import youtube from "../../assets/website-icons/youtube.svg";
import discord from "../../assets/website-icons/discord.svg";
import facebook from "../../assets/website-icons/facebook.svg";
import instagram from "../../assets/website-icons/instagram.svg";
import linkedin from "../../assets/website-icons/linkedin.svg";
import tiktok from "../../assets/website-icons/tiktok.svg";
import gitlab from "../../assets/website-icons/gitlab.svg";
import stackoverflow from "../../assets/website-icons/stackoverflow.svg";
import wikipedia from "../../assets/website-icons/wikipedia.svg";
import telegram from "../../assets/website-icons/telegram.svg";

type ComposerLinkSite = {
  id: string;
  hosts: readonly string[];
  src: string;
  multicolor?: boolean;
};

/** Qone's additional website mappings; these are separate from the Codex registry. */
export const additionalComposerLinkSites: readonly ComposerLinkSite[] = [
  { id: "cloudflare", hosts: ["cloudflare.com"], src: cloudflare, multicolor: true },
  { id: "reddit", hosts: ["reddit.com", "redd.it"], src: reddit },
  { id: "x", hosts: ["x.com", "twitter.com", "t.co"], src: x },
  { id: "youtube", hosts: ["youtube.com", "youtu.be"], src: youtube },
  { id: "discord", hosts: ["discord.com", "discord.gg", "discordapp.com"], src: discord },
  { id: "bilibili", hosts: ["bilibili.com", "b23.tv"], src: bilibili, multicolor: true },
  { id: "gitlab", hosts: ["gitlab.com"], src: gitlab },
  { id: "stackoverflow", hosts: ["stackoverflow.com"], src: stackoverflow },
  { id: "wikipedia", hosts: ["wikipedia.org"], src: wikipedia },
  { id: "telegram", hosts: ["telegram.org", "t.me"], src: telegram },
  { id: "huggingface", hosts: ["huggingface.co"], src: huggingface, multicolor: true },
  { id: "vercel", hosts: ["vercel.com"], src: vercel },
  // Specific products precede the parent brand's domain.
  { id: "chatgpt", hosts: ["chatgpt.com", "chat.openai.com"], src: openai },
  { id: "openai", hosts: ["openai.com"], src: openai },
  { id: "claude", hosts: ["claude.ai"], src: claude, multicolor: true },
  { id: "deepseek", hosts: ["deepseek.com"], src: deepseek, multicolor: true },
  { id: "google", hosts: ["google.com"], src: google, multicolor: true },
  { id: "facebook", hosts: ["facebook.com", "fb.com", "fb.watch"], src: facebook },
  { id: "instagram", hosts: ["instagram.com"], src: instagram },
  { id: "linkedin", hosts: ["linkedin.com", "lnkd.in"], src: linkedin },
  { id: "tiktok", hosts: ["tiktok.com"], src: tiktok },
];
