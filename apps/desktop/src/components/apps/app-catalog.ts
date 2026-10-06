import tiktokLogo from "../../assets/app-icons/tiktok.svg";
import bilibiliLogo from "../../assets/app-icons/bilibili.svg";
import youtubeLogo from "../../assets/app-icons/youtube.svg";
import telegramLogo from "../../assets/app-icons/telegram.svg";
import xLogo from "../../assets/app-icons/x.svg";
import redditLogo from "../../assets/app-icons/reddit.svg";
import { findSite } from "@qone/protocol";

export type DownloadApp = {
  id: string;
  name: string;
  loginUrl: string;
  icon: string;
  tone: string;
};

export const DOWNLOAD_APPS: DownloadApp[] = [
  { id: "douyin", name: "抖音", loginUrl: findSite("douyin")!.loginUrl, icon: tiktokLogo, tone: "rose" },
  { id: "tiktok", name: "TikTok", loginUrl: findSite("tiktok")!.loginUrl, icon: tiktokLogo, tone: "cyan" },
  { id: "bilibili", name: "哔哩哔哩", loginUrl: findSite("bilibili")!.loginUrl, icon: bilibiliLogo, tone: "blue" },
  { id: "youtube", name: "YouTube", loginUrl: findSite("youtube")!.loginUrl, icon: youtubeLogo, tone: "red" },
  { id: "telegram", name: "Telegram", loginUrl: findSite("telegram")!.loginUrl, icon: telegramLogo, tone: "blue" },
  { id: "x", name: "X", loginUrl: findSite("x")!.loginUrl, icon: xLogo, tone: "slate" },
  { id: "reddit", name: "Reddit", loginUrl: findSite("reddit")!.loginUrl, icon: redditLogo, tone: "orange" },
];

export function findDownloadApp(id: string): DownloadApp | undefined {
  return DOWNLOAD_APPS.find((app) => app.id === id);
}
import { reachCookieSecretKey } from "@qone/protocol";

export function appCookieKey(appId: string): string {
  return reachCookieSecretKey(appId === "x" ? "twitter" : appId) ?? `apps.cookie:${appId}`;
}

// Tauri Secret keys must use the `namespace:name` form.
export const TELEGRAM_API_ID_KEY = "apps.telegram:apiId";
export const TELEGRAM_API_HASH_KEY = "apps.telegram:apiHash";
