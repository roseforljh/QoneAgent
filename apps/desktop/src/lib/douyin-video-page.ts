import { douyinContentId, type DouyinAuthorResult, type DouyinBridgeFailure } from "@qone/protocol";

export interface DouyinPlayback {
  contentId: string;
  pageUrl: string;
  videoUrl: string;
  videoUrls?: string[];
  userAgent?: string;
}

export function isDouyinBridgeResult(value: unknown, requestUrl: string): value is DouyinPlayback {
  if (!value || typeof value !== "object") return false;
  const result = value as Record<string, unknown>;
  const id = typeof result.pageUrl === "string" ? douyinContentId(result.pageUrl) : undefined;
  const expectedId = douyinContentId(requestUrl);
  const http = (url: unknown) => {
    try { return typeof url === "string" && ["http:", "https:"].includes(new URL(url).protocol); }
    catch { return false; }
  };
  return Boolean(id && result.contentId === id && (!expectedId || expectedId === id) && http(result.videoUrl)
    && (result.videoUrls === undefined || Array.isArray(result.videoUrls) && result.videoUrls[0] === result.videoUrl && result.videoUrls.every(http))
    && (result.userAgent === undefined || typeof result.userAgent === "string"));
}

// Keep only the latest creator batch, consume each address once, never persist
// signed URLs or return them in the list tool's model-visible metadata.
const playbacks = new Map<string, DouyinPlayback>();
export function rememberDouyinPlaybacks(result: DouyinAuthorResult, values: unknown): void {
  playbacks.clear();
  if (!Array.isArray(values)) return;
  const allowed = new Map(result.videos.map((video) => [video.contentId, video.url]));
  for (const value of values) {
    const url = allowed.get(value?.contentId);
    if (url && isDouyinBridgeResult(value, url)) playbacks.set(value.contentId, value);
  }
}

export function takeDouyinPlayback(url: string): DouyinPlayback | undefined {
  const id = douyinContentId(url);
  if (!id) return;
  const value = playbacks.get(id);
  playbacks.delete(id);
  return value;
}

export class DouyinPageError extends Error {
  constructor(readonly failure: DouyinBridgeFailure, message: string) { super(message); }
}

/** Shared by post, detail and SSR probes; only call with a verified work object. */
export const DOUYIN_PLAYBACK_HELPERS = String.raw`
  const absolute = (value) => {
    if (typeof value !== "string" || !value) return "";
    try {
      const url = new URL(value.replace(/\\u002F/g, "/").replace(/\\u003A/g, ":"), location.href);
      return /^https?:$/.test(url.protocol) ? url.href : "";
    } catch { return ""; }
  };
  const playback = (item, pageUrl) => {
    const contentId = item?.aweme_id || item?.awemeId;
    const video = item?.video;
    if (typeof contentId !== "string" || !/^\d+$/.test(contentId) || !video
      || item.images?.length || item.image_post_info?.images?.length) return;
    const rates = Array.isArray(video.bit_rate) ? [...video.bit_rate].filter((rate) => rate?.play_addr) : [];
    rates.sort((a, b) => (Number(b.bit_rate) || 0) - (Number(a.bit_rate) || 0));
    for (const source of [...rates.map((rate) => rate.play_addr), video.play_addr, video.playAddr,
      video.play_addr_h264, video.play_addr_265, video.play_addr_256]) {
      const list = source?.url_list || source?.urlList;
      if (!Array.isArray(list)) continue;
      const videoUrls = [...new Set(list.map(absolute).filter(Boolean))];
      if (videoUrls.length) return { contentId, pageUrl, videoUrl: videoUrls[0], videoUrls, userAgent: navigator.userAgent };
    }
  };
`;
