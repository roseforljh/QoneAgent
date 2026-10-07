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
import { siteHosts } from "@qone/protocol";

type ComposerLinkSite = {
  id: string;
  hosts: readonly string[];
  src: string;
  multicolor?: boolean;
};

/** Qone's additional website mappings; these are separate from the Codex registry. */
export const additionalComposerLinkSites: readonly ComposerLinkSite[] = [
  { id: "cloudflare", hosts: ["cloudflare.com"], src: cloudflare, multicolor: true },
  { id: "reddit", hosts: siteHosts("reddit"), src: reddit },
  { id: "x", hosts: siteHosts("x"), src: x },
  { id: "youtube", hosts: siteHosts("youtube"), src: youtube },
  { id: "discord", hosts: ["discord.com", "discord.gg", "discordapp.com"], src: discord },
  { id: "bilibili", hosts: siteHosts("bilibili"), src: bilibili, multicolor: true },
  { id: "gitlab", hosts: ["gitlab.com"], src: gitlab },
  { id: "stackoverflow", hosts: ["stackoverflow.com"], src: stackoverflow },
  { id: "wikipedia", hosts: ["wikipedia.org"], src: wikipedia },
  { id: "huggingface", hosts: ["huggingface.co"], src: huggingface, multicolor: true },
  { id: "vercel", hosts: ["vercel.com"], src: vercel },
  // Specific products precede the parent brand's domain.
  { id: "chatgpt", hosts: ["chatgpt.com", "chat.openai.com"], src: openai },
  { id: "openai", hosts: ["openai.com"], src: openai },
  { id: "claude", hosts: ["claude.ai"], src: claude, multicolor: true },
  { id: "deepseek", hosts: ["deepseek.com"], src: deepseek, multicolor: true },
  { id: "google", hosts: ["google.com"], src: google, multicolor: true },
  { id: "facebook", hosts: siteHosts("facebook"), src: facebook },
  { id: "instagram", hosts: siteHosts("instagram"), src: instagram },
  { id: "linkedin", hosts: siteHosts("linkedin"), src: linkedin },
  { id: "tiktok", hosts: siteHosts("tiktok"), src: tiktok },
];
