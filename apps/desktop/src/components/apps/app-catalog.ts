import tiktokLogo from "../../assets/app-icons/tiktok.svg";
import youtubeLogo from "../../assets/app-icons/youtube.svg";
import telegramLogo from "../../assets/app-icons/telegram.svg";
import xLogo from "../../assets/app-icons/x.svg";
import redditLogo from "../../assets/app-icons/reddit.svg";

export type DownloadApp = {
  id: string;
  name: string;
  loginUrl: string;
  icon: string;
  tone: string;
};

export const DOWNLOAD_APPS: DownloadApp[] = [
  { id: "douyin", name: "抖音", loginUrl: "https://www.douyin.com/", icon: tiktokLogo, tone: "rose" },
  { id: "tiktok", name: "TikTok", loginUrl: "https://www.tiktok.com/login", icon: tiktokLogo, tone: "cyan" },
  { id: "youtube", name: "YouTube", loginUrl: "https://www.youtube.com/", icon: youtubeLogo, tone: "red" },
  { id: "telegram", name: "Telegram", loginUrl: "https://web.telegram.org/", icon: telegramLogo, tone: "blue" },
  { id: "x", name: "X", loginUrl: "https://x.com/i/flow/login", icon: xLogo, tone: "slate" },
  { id: "reddit", name: "Reddit", loginUrl: "https://www.reddit.com/login/", icon: redditLogo, tone: "orange" },
];

export function findDownloadApp(id: string): DownloadApp | undefined {
  return DOWNLOAD_APPS.find((app) => app.id === id);
}
import { reachCookieSecretKey } from "@qone/protocol";

export function appCookieKey(appId: string): string {
  return reachCookieSecretKey(appId === "x" ? "twitter" : appId) ?? `apps.cookie:${appId}`;
}
