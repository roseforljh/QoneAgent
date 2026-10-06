import { douyinContentId, isDouyinOwnerResult, isDouyinUrl, siteHostRegexSource } from "@qone/protocol";
import { douyinOwnerObserver } from "./douyin-author-page";
import { douyinOwnerScript } from "./douyin-owner-page";
import { DOUYIN_PLAYBACK_HELPERS, DouyinPageError, isDouyinBridgeResult, takeDouyinPlayback } from "./douyin-video-page";
import { BACKGROUND_BROWSER_BOUNDS, BROWSER_POLL_INTERVAL_MS, DOUYIN_VIDEO_TIMEOUT_MS } from "./background-browser";
export { isDouyinBridgeResult } from "./douyin-video-page";
export const DOUYIN_BROWSER_ID = "auth-page-douyin";
const DOUYIN_HOST_PATTERN = JSON.stringify(siteHostRegexSource("douyin"));

export function douyinVideoUrlScript(url: string): string {
  return DOUYIN_VIDEO_URL_SCRIPT.replace("/* expectedId */ null", JSON.stringify(douyinContentId(url) ?? null)).replace("/* hostPattern */ null", DOUYIN_HOST_PATTERN);
}

/** Uncached requests own a hidden page sharing the persistent login profile. */
export async function resolveDouyinPage(
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>,
  request: { requestId: string; url: string; operation?: string },
  signal: AbortSignal,
): Promise<string> {
  if (!isDouyinUrl(request.url)) throw new Error("抖音链接无效");
  const owner = request.operation === "owner";
  signal.throwIfAborted();
  if (!owner) {
    const cached = takeDouyinPlayback(request.url);
    if (cached) return JSON.stringify(cached);
  }
  const browserId = `douyin-${owner ? "owner" : "video"}-${request.requestId}`;
  try {
    signal.throwIfAborted();
    await invoke("browser_open", { browserId, url: request.url, ...BACKGROUND_BROWSER_BOUNDS,
      initializationScript: douyinOwnerObserver(request.url) });
    const deadline = Date.now() + DOUYIN_VIDEO_TIMEOUT_MS;
    const script = owner ? douyinOwnerScript(request.url) : douyinVideoUrlScript(request.url);
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      const raw = await invoke<string>("browser_eval_result", { browserId, script });
      signal.throwIfAborted();
      const result: unknown = JSON.parse(raw);
      // WebView2 can return null while navigation creates a new document.
      const payload: unknown = typeof result === "string" ? JSON.parse(result) : undefined;
      if ((owner ? isDouyinOwnerResult : isDouyinBridgeResult)(payload, request.url) && Date.now() < deadline) return JSON.stringify(payload);
      if (!owner && payload && typeof payload === "object" && "failure" in payload) {
        if (payload.failure === "work_unavailable") throw new DouyinPageError("work_unavailable", "目标作品详情未提供可下载视频地址，可能为图集或不可用作品");
        if (payload.failure === "page_unavailable") throw new DouyinPageError("page_unavailable", "目标详情接口未返回有效数据，页面可能需要验证；已停止批量解析");
      }
      await new Promise<void>((resolve) => setTimeout(resolve, BROWSER_POLL_INTERVAL_MS));
    }
    throw new DouyinPageError("metadata_timeout", owner ? "页面未返回匹配作品的博主详情，不能确认登录是否失效"
      : "页面未返回匹配作品的播放数据，已停止批量解析；仅凭此错误不能判断 Cookie 无效");
  } finally {
    await invoke("browser_close", { browserId }).catch(() => undefined);
  }
}

/**
 * Runs one synchronous probe inside the logged-in Douyin WebView. The caller
 * repeats this probe while the page finishes loading because WebView2's
 * ExecuteScript callback does not await a returned Promise.
 * The script returns a JSON string because WebView2 wraps ExecuteScript values
 * in JSON before returning them to native code.
 */
export const DOUYIN_VIDEO_URL_SCRIPT = String.raw`(() => {
  ${DOUYIN_PLAYBACK_HELPERS}
  const expectedId = /* expectedId */ null;
  const page = new URL(location.href);
  const contentId = /^\/(?:share\/)?(?:video|note|gallery|slides)\/(\d+)(?:\/|$)/i.exec(page.pathname)?.[1]
    || /^\d+$/.exec(page.searchParams.get("modal_id") || "")?.[0];
  const hostPattern = /* hostPattern */ null;
  if (!/^(?:http|https):$/.test(page.protocol) || !new RegExp(hostPattern, "i").test(page.hostname)
    || !contentId || expectedId && expectedId !== contentId) return JSON.stringify({ pageUrl: location.href });
  const state = window.__qoneDouyinAuthor;
  if (state?.playback?.contentId === contentId) return JSON.stringify(state.playback);
  // Only use URLs inside the requested work's structured data, never global HTML matches.
  const visit = (data) => {
    if (!data || typeof data !== "object") return;
    if (String(data.aweme_id || data.awemeId || "") === contentId && data.video) {
      const media = playback(data, location.href);
      if (media) return media;
    }
    for (const value of Object.values(data)) {
      const found = visit(value);
      if (found) return found;
    }
  };
  let media;
  for (const node of document.querySelectorAll('script[type="application/json"], script#RENDER_DATA')) {
    try {
      const text = node.textContent || "";
      const data = JSON.parse(node.id === "RENDER_DATA" ? decodeURIComponent(text) : text);
      media = visit(data);
      if (media) return JSON.stringify(media);
    } catch { /* Unrelated scripts need not contain JSON. */ }
  }
  const pick = () => {
    const video = Array.from(document.querySelectorAll("video")).map((node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const area = Math.max(0, Math.min(rect.right, innerWidth) - Math.max(rect.left, 0))
        * Math.max(0, Math.min(rect.bottom, innerHeight) - Math.max(rect.top, 0));
      const visible = style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && area > 0;
      return { value: absolute(node.currentSrc || node.src || node.querySelector("source")?.src || ""), area, visible };
    }).filter((item) => item.visible && item.value);
    // Multiple visible players cannot be associated with the work reliably without metadata.
    return video.length === 1 ? video[0].value : "";
  };

  const videoUrl = pick();
  return JSON.stringify({ videoUrl, pageUrl: location.href, contentId, userAgent: navigator.userAgent,
    failure: videoUrl ? undefined : state?.playbackFailure || (state?.error ? "page_unavailable" : undefined) });
})()`;
