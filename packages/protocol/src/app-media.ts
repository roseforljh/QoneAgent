import { siteHostIsAlias, siteHosts } from "./site-config";

export const MEDIA_APP_IDS = ["tiktok", "bilibili", "youtube", "x", "reddit"] as const;
export type MediaAppId = (typeof MEDIA_APP_IDS)[number];
export type MediaAppMode = "video" | "audio" | "subtitles";

const HOSTS = Object.fromEntries(MEDIA_APP_IDS.map((app) => [app, siteHosts(app)])) as Record<MediaAppId, readonly string[]>;

export function mediaAppFromUrl(value: string): MediaAppId | undefined {
  try {
    const url = new URL(value);
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.port) return;
    return MEDIA_APP_IDS.find((app) => HOSTS[app].some((host) => url.hostname === host || url.hostname.endsWith(`.${host}`)));
  } catch { return; }
}

export function mediaAppHostIsAlias(app: MediaAppId, hostname: string): boolean {
  return siteHostIsAlias(app, hostname);
}

/** String identifiers keep large TikTok/X IDs intact and never become file paths. */
export function mediaAppContentId(app: MediaAppId, value: string): string | undefined {
  if (mediaAppFromUrl(value) !== app) return;
  const url = new URL(value);
  switch (app) {
    case "tiktok": return /^\/@[^/]+\/(?:video|photo)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    case "bilibili": {
      const path = url.pathname;
      return /^\/video\/(BV[a-zA-Z0-9]+)(?:\/|$)/.exec(path)?.[1]
        ?? /^\/video\/av(\d+)(?:\/|$)/i.exec(path)?.[1]
        ?? /^\/bangumi\/play\/ep(\d+)(?:\/|$)/i.exec(path)?.[1];
    }
    case "youtube": {
      const id = url.hostname === "youtu.be" ? url.pathname.slice(1).split("/")[0]
        : /^\/(?:shorts|embed|live)\/([^/]+)/.exec(url.pathname)?.[1] ?? url.searchParams.get("v");
      return id && /^[a-zA-Z0-9_-]{11}$/.test(id) ? id : undefined;
    }
    case "x": return /^\/(?:[^/]+\/status|i\/status|i\/web\/status)\/(\d+)(?:\/|$)/.exec(url.pathname)?.[1];
    case "reddit": return url.hostname === "redd.it" ? /^\/([a-z0-9]+)\/?$/i.exec(url.pathname)?.[1]
      : /\/comments\/([a-z0-9]+)(?:\/|\.json|$)/i.exec(url.pathname)?.[1];
  }
}

export function mediaAppProfile(app: MediaAppId, value: string): string | undefined {
  if (mediaAppFromUrl(value) !== app || mediaAppContentId(app, value)) return;
  const url = new URL(value);
  if (app === "tiktok") return /^\/@([^/]+)\/?$/.exec(url.pathname)?.[1];
  if (app === "bilibili") return /^\/(\d+)(?:\/video)?\/?$/.exec(url.pathname)?.[1];
  if (app === "youtube") return /^\/(?:channel\/([^/]+)|(@[^/]+))(?:\/(?:videos|shorts))?\/?$/.exec(url.pathname)?.slice(1).find(Boolean)
    ?? (url.pathname === "/playlist" ? url.searchParams.get("list") ?? undefined : undefined);
  if (app === "x") {
    const name = /^\/([a-zA-Z0-9_]+)(?:\/media)?\/?$/.exec(url.pathname)?.[1];
    return name && !["home", "explore", "notifications", "messages", "settings", "search", "i", "compose"].includes(name.toLowerCase()) ? name : undefined;
  }
  if (app === "reddit") return /^\/(?:r|u|user)\/([a-zA-Z0-9_-]+)(?:\/(?:new|hot|top|submitted))?\/?$/.exec(url.pathname)?.[1];
}

export interface AppMediaItem {
  id: string;
  url: string;
  title: string;
  description: string;
  descriptionTruncated?: boolean;
  author: string;
  authorUrl?: string;
  duration?: number;
  mediaCount?: number;
}
export interface AppMediaList {
  app: MediaAppId;
  url: string;
  items: AppMediaItem[];
  completion: "limit" | "exhausted" | "stalled" | "timeout" | "blocked";
}

export function isAppMediaList(value: unknown, app: MediaAppId, url: string, limit: number): value is AppMediaList {
  if (!value || typeof value !== "object") return false;
  const result = value as AppMediaList;
  if (result.app !== app || result.url !== url || !Array.isArray(result.items) || result.items.length > limit
    || !["limit", "exhausted", "stalled", "timeout", "blocked"].includes(result.completion)) return false;
  const seen = new Set<string>();
  for (const item of result.items) {
    if (!item || typeof item.id !== "string" || mediaAppContentId(app, item.url) !== item.id || seen.has(item.id)
      || typeof item.title !== "string" || typeof item.description !== "string" || typeof item.author !== "string") return false;
    seen.add(item.id);
  }
  return result.completion !== "limit" || result.items.length === limit;
}
