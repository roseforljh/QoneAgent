import { douyinAuthorId, douyinContentId, isDouyinAuthorResult, type DouyinAuthorResult } from "@qone/protocol";
import { DOUYIN_PLAYBACK_HELPERS, rememberDouyinPlaybacks } from "./douyin-video-page";

/** Observe the same post responses as upstream collect_user_post_ids_via_browser.
 * Install before document scripts so the first signed page request is included.
 * We never construct/sign API requests or scan unrelated recommendation HTML.
 */
export function douyinAuthorObserver(authorId: string, limit: number): string {
  return AUTHOR_OBSERVER.replace("/* authorId */ null", JSON.stringify(authorId)).replace("/* limit */ 0", String(limit));
}

export function douyinOwnerObserver(url: string): string {
  return douyinAuthorObserver("", 0).replace("/* owner */ false", "true")
    .replace("/* expectedId */ null", JSON.stringify(douyinContentId(url) ?? null));
}

const AUTHOR_OBSERVER = String.raw`(() => {
  if (window !== window.top) return;
  ${DOUYIN_PLAYBACK_HELPERS}
  const authorId = /* authorId */ null;
  const limit = /* limit */ 0;
  const ownerMode = /* owner */ false;
  const expectedId = /* expectedId */ null;
  const state = { authorId, limit, pages: new Map(), playbacks: new Map(), nickname: "", error: false, lastScroll: 0 };
  window.__qoneDouyinAuthor = state;
  const requestUrl = (value) => {
    try {
      const url = new URL(value, location.href);
      // Endpoint and owner parameter are the upstream post API contract.
      if (ownerMode) {
        const page = new URL(location.href);
        const id = expectedId || /^\/(?:share\/)?(?:video|note|gallery|slides)\/(\d+)(?:\/|$)/.exec(page.pathname)?.[1] || page.searchParams.get("modal_id");
        return id && url.origin === location.origin && url.pathname === "/aweme/v1/web/aweme/detail/"
          && url.searchParams.get("aweme_id") === id ? url : null;
      }
      return url.origin === location.origin && url.pathname === "/aweme/v1/web/aweme/post/"
        && url.searchParams.get("sec_user_id") === authorId ? url : null;
    } catch { return null; }
  };
  const collect = (url, data, ok) => {
    if (ownerMode) {
      const item = data?.aweme_detail;
      const page = new URL(location.href);
      const pageId = /^\/(?:share\/)?(?:video|note|gallery|slides)\/(\d+)(?:\/|$)/.exec(page.pathname)?.[1] || page.searchParams.get("modal_id");
      const id = item?.aweme_id || item?.awemeId;
      const owner = item?.author?.sec_uid || item?.author?.secUid;
      if (!pageId || url.searchParams.get("aweme_id") !== pageId || expectedId && expectedId !== pageId) return;
      if (!ok || !data || data.status_code !== undefined && data.status_code !== 0) { state.error = true; return; }
      if (id !== pageId) return;
      state.error = false;
      state.playback = playback(item, location.href);
      state.playbackFailure = state.playback ? undefined : "work_unavailable";
      if (typeof owner === "string" && /^[a-zA-Z0-9_-]+$/.test(owner) && owner !== "self") {
        state.owner = { contentId: id, videoPageUrl: location.href, authorId: owner,
          profileUrl: new URL("/user/" + owner, location.origin).href, nickname: String(item.author.nickname || "").slice(0, 100) };
      }
      return;
    }
    if (!ok || !data || data.status_code !== undefined && data.status_code !== 0 || !Array.isArray(data.aweme_list)) {
      state.error = true;
      return;
    }
    const videos = [];
    for (const item of data.aweme_list) {
      const owner = item?.author?.sec_uid || item?.author?.secUid;
      const id = item?.aweme_id || item?.awemeId;
      if (owner !== authorId || typeof id !== "string" || !/^\d+$/.test(id)) continue;
      state.nickname = String(item.author.nickname || "").slice(0, 100);
      if (!item.video || item.images?.length || item.image_post_info?.images?.length) continue;
      const media = playback(item, new URL("/video/" + id, location.origin).href);
      if (media) state.playbacks.set(id, media);
      videos.push({ contentId: id, authorId, url: new URL("/video/" + id, location.origin).href,
        description: String(item.desc || "").slice(0, 200),
        createdAt: Number.isFinite(item.create_time) && item.create_time >= 0 ? item.create_time : 0,
        pinned: item.is_top === true || item.is_top === 1 });
    }
    if (data.has_more !== 0 && data.has_more !== 1 && data.has_more !== false && data.has_more !== true) {
      state.error = true;
      return;
    }
    const more = Boolean(data.has_more);
    const next = String(data.max_cursor ?? "");
    if (more && !/^\d+$/.test(next)) { state.error = true; return; }
    state.pages.set(url.searchParams.get("max_cursor") || "0", { videos, next, more });
    state.error = false;
  };
  const originalFetch = window.fetch;
  if (originalFetch) window.fetch = function(...args) {
    const url = requestUrl(typeof args[0] === "string" || args[0] instanceof URL ? args[0] : args[0]?.url);
    const pending = Reflect.apply(originalFetch, this, args);
    if (url) pending.then((response) => response.clone().json()
      .then((data) => collect(url, data, response.ok))).catch(() => { state.error = true; });
    return pending;
  };
  const requests = new WeakMap();
  const originalOpen = XMLHttpRequest.prototype.open;
  XMLHttpRequest.prototype.open = function(...args) {
    requests.set(this, requestUrl(args[1]));
    return Reflect.apply(originalOpen, this, args);
  };
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.send = function(...args) {
    const url = requests.get(this);
    if (url) this.addEventListener("loadend", () => {
      try { collect(url, this.responseType === "json" ? this.response : JSON.parse(this.responseText), this.status >= 200 && this.status < 300); }
      catch { state.error = true; }
    }, { once: true });
    return Reflect.apply(originalSend, this, args);
  };
})()`;

export const DOUYIN_AUTHOR_SNAPSHOT = String.raw`(() => {
  const state = window.__qoneDouyinAuthor;
  const page = new URL(location.href);
  const id = /^\/user\/([^/]+)(?:\/|$)/.exec(page.pathname)?.[1];
  if (!state || id !== state.authorId || !/(?:^|\.)(?:douyin|iesdouyin)\.com$/i.test(page.hostname)) return null;
  const videos = [], seen = new Set(), cursors = new Set();
  let cursor = "0", exhausted = false, stalled = false;
  // Walk cursor order, not response completion order. Deduplicate across pages.
  while (state.pages.has(cursor) && videos.length < state.limit) {
    if (cursors.has(cursor)) { stalled = true; break; }
    cursors.add(cursor);
    const batch = state.pages.get(cursor);
    for (const video of batch.videos) {
      if (!seen.has(video.contentId)) { seen.add(video.contentId); videos.push(video); }
      if (videos.length === state.limit) break;
    }
    if (!batch.more) { exhausted = true; break; }
    cursor = batch.next;
  }
  // Scroll actual scroll containers, without selectors tied to a site's CSS build.
  if (!exhausted && !stalled && !state.error && videos.length < state.limit && Date.now() - state.lastScroll >= 1000) {
    state.lastScroll = Date.now();
    document.scrollingElement?.scrollTo(0, document.scrollingElement.scrollHeight);
    for (const element of document.querySelectorAll("*")) {
      if (element.clientHeight > 0 && element.scrollHeight > element.clientHeight
        && /^(auto|scroll)$/.test(getComputedStyle(element).overflowY)) element.scrollBy(0, element.clientHeight);
    }
  }
  return JSON.stringify({ pageUrl: location.href, authorId: state.authorId, nickname: state.nickname, videos,
    playbacks: videos.map((video) => state.playbacks.get(video.contentId)).filter(Boolean),
    completion: videos.length === state.limit ? "limit" : exhausted ? "exhausted" : stalled ? "stalled" : state.error ? "blocked" : "timeout",
    pages: cursors.size });
})()`;

export async function resolveDouyinAuthorPage(
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>,
  request: { requestId: string; url: string; limit?: number },
  signal: AbortSignal,
): Promise<string> {
  const authorId = douyinAuthorId(request.url);
  const limit = request.limit;
  if (!authorId || !Number.isSafeInteger(limit) || !limit || limit < 1 || limit > 100) throw new Error("需要完整抖音博主主页链接，数量须为 1–100");
  const browserId = `douyin-author-${request.requestId}`;
  let last: DouyinAuthorResult | undefined;
  let lastProgressAt = Date.now();
  let pages = 0;
  const finish = (result: DouyinAuthorResult): string => {
    const { playbacks, ...metadata } = result as DouyinAuthorResult & { playbacks?: unknown };
    rememberDouyinPlaybacks(result, playbacks);
    return JSON.stringify(metadata);
  };
  try {
    signal.throwIfAborted();
    await invoke("browser_open", { browserId, url: request.url, x: -32000, y: -32000, w: 1280, h: 720,
      initializationScript: douyinAuthorObserver(authorId, limit) });
    const deadline = Date.now() + 90_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const raw = await invoke<string>("browser_eval_result", { browserId, script: DOUYIN_AUTHOR_SNAPSHOT });
      signal.throwIfAborted();
      const wrapped: unknown = JSON.parse(raw);
      const snapshot: unknown = typeof wrapped === "string" ? JSON.parse(wrapped) : undefined;
      if (isDouyinAuthorResult(snapshot, request.url, limit)) {
        const progress = (snapshot as DouyinAuthorResult & { pages?: number }).pages ?? 0;
        if (progress > pages) { pages = progress; lastProgressAt = Date.now(); }
        last = snapshot;
        if (Date.now() >= deadline) break;
        if (snapshot.completion === "limit" || snapshot.completion === "exhausted" || snapshot.completion === "stalled") return finish(snapshot);
        if (pages && Date.now() - lastProgressAt > 15_000) return finish({ ...snapshot, completion: snapshot.completion === "blocked" ? "blocked" : "stalled" });
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }
    if (last) return finish({ ...last, completion: last.completion === "blocked" ? "blocked" : "timeout" });
    throw new Error("未获取到该博主的作品列表，请在抖音登录页确认登录和验证状态");
  } finally { await invoke("browser_close", { browserId }).catch(() => undefined); }
}
