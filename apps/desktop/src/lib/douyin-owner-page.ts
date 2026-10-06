import { douyinContentId, siteHostRegexSource } from "@qone/protocol";

/** A video's matching detail metadata is the authority for its creator. */
export function douyinOwnerScript(url: string): string {
  return OWNER_SCRIPT.replace("/* expectedId */ null", JSON.stringify(douyinContentId(url) ?? null)).replace("/* hostPattern */ null", JSON.stringify(siteHostRegexSource("douyin")));
}

const OWNER_SCRIPT = String.raw`(() => {
  const expectedId = /* expectedId */ null;
  const hostPattern = /* hostPattern */ null;
  const page = new URL(location.href);
  const contentId = /^\/(?:share\/)?video\/(\d+)(?:\/|$)/.exec(page.pathname)?.[1]
    || /^\d+$/.exec(page.searchParams.get("modal_id") || "")?.[0];
  if (!/^https?:$/.test(page.protocol) || !new RegExp(hostPattern, "i").test(page.hostname)
    || !contentId || expectedId && contentId !== expectedId) return null;
  const observed = window.__qoneDouyinAuthor?.owner;
  if (observed?.contentId === contentId) return JSON.stringify({ ...observed, videoPageUrl: location.href });
  const visit = (data) => {
    if (!data || typeof data !== "object") return null;
    if ((data.aweme_id || data.awemeId) === contentId) {
      const authorId = data.author?.sec_uid || data.author?.secUid;
      if (typeof authorId === "string" && /^[a-zA-Z0-9_-]+$/.test(authorId) && authorId !== "self") {
        return { contentId, videoPageUrl: location.href, authorId, profileUrl: new URL("/user/" + authorId, location.origin).href,
          nickname: String(data.author.nickname || "").slice(0, 100) };
      }
    }
    for (const value of Object.values(data)) { const found = visit(value); if (found) return found; }
    return null;
  };
  for (const node of document.querySelectorAll('script[type="application/json"], script#RENDER_DATA')) {
    try {
      const text = node.textContent || "";
      const result = visit(JSON.parse(node.id === "RENDER_DATA" ? decodeURIComponent(text) : text));
      if (result) return JSON.stringify(result);
    } catch { /* Unrelated page JSON is not creator evidence. */ }
  }
  return null;
})()`;
