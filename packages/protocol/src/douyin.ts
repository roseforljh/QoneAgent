export function isDouyinUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol)
      && /(?:^|\.)(?:douyin|iesdouyin)\.com$/i.test(url.hostname);
  } catch { return false; }
}

/** IDs must remain strings: Douyin IDs exceed JavaScript's safe integer range. */
export function douyinContentId(value: string): string | undefined {
  if (!isDouyinUrl(value)) return undefined;
  const url = new URL(value);
  return /^\/(?:share\/)?(?:video|note|gallery|slides)\/(\d+)(?:\/|$)/i.exec(url.pathname)?.[1]
    ?? /^\d+$/.exec(url.searchParams.get("modal_id") ?? "")?.[0];
}

export function douyinAuthorId(value: string): string | undefined {
  if (!isDouyinUrl(value)) return undefined;
  const id = /^\/(?:share\/)?user\/([^/]+)(?:\/|$)/i.exec(new URL(value).pathname)?.[1];
  return id && id !== "self" && /^[a-zA-Z0-9_-]+$/.test(id) ? id : undefined;
}

export interface DouyinAuthorVideo {
  contentId: string;
  authorId: string;
  url: string;
  description: string;
  createdAt: number;
  pinned: boolean;
}

/** Page/transport failures stop a batch; a confirmed unavailable work does not. */
export type DouyinBridgeFailure = "metadata_timeout" | "page_unavailable" | "work_unavailable";

export interface DouyinOwnerResult {
  videoPageUrl: string;
  contentId: string;
  authorId: string;
  profileUrl: string;
  nickname: string;
}

export function isDouyinOwnerResult(value: unknown, requestUrl: string): value is DouyinOwnerResult {
  if (!value || typeof value !== "object") return false;
  const result = value as DouyinOwnerResult;
  const expectedId = douyinContentId(requestUrl);
  const contentId = typeof result.videoPageUrl === "string" ? douyinContentId(result.videoPageUrl) : undefined;
  return Boolean(contentId && result.contentId === contentId && (!expectedId || expectedId === contentId)
    && typeof result.profileUrl === "string" && douyinAuthorId(result.profileUrl) === result.authorId
    && typeof result.authorId === "string" && result.authorId && typeof result.nickname === "string");
}

export interface DouyinAuthorResult {
  pageUrl: string;
  authorId: string;
  nickname: string;
  videos: DouyinAuthorVideo[];
  completion: "limit" | "exhausted" | "timeout" | "stalled" | "blocked";
}

/** Reject unrelated/recommended works at both sides of the page bridge. */
export function isDouyinAuthorResult(value: unknown, requestUrl: string, limit: number): value is DouyinAuthorResult {
  if (!value || typeof value !== "object") return false;
  const result = value as DouyinAuthorResult;
  const authorId = typeof result.pageUrl === "string" ? douyinAuthorId(result.pageUrl) : undefined;
  if (!authorId || authorId !== douyinAuthorId(requestUrl) || result.authorId !== authorId
    || typeof result.nickname !== "string" || !Array.isArray(result.videos) || result.videos.length > limit
    || !["limit", "exhausted", "timeout", "stalled", "blocked"].includes(result.completion)) return false;
  const ids = new Set<string>();
  for (const item of result.videos) {
    if (!item || typeof item.contentId !== "string" || !/^\d+$/.test(item.contentId) || ids.has(item.contentId)
      || item.authorId !== authorId || typeof item.url !== "string" || douyinContentId(item.url) !== item.contentId
      || typeof item.description !== "string" || !Number.isFinite(item.createdAt) || item.createdAt < 0
      || typeof item.pinned !== "boolean") return false;
    ids.add(item.contentId);
  }
  return result.completion !== "limit" || result.videos.length === limit;
}
