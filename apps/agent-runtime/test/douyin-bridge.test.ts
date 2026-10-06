import { describe, expect, test } from "bun:test";
import { DouyinBridge, DouyinBridgeError, isDouyinUrl } from "../src/douyin-bridge.js";

describe("Douyin page bridge", () => {
  test("accepts Douyin hosts and rejects unrelated URLs", () => {
    expect(isDouyinUrl("https://www.douyin.com/video/123")).toBe(true);
    expect(isDouyinUrl("https://v.douyin.com/abc/")).toBe(true);
    expect(isDouyinUrl("https://www.tiktok.com/@user/video/123")).toBe(false);
  });

  test("resolves a bridge response without exposing it as a tool error", async () => {
    let request: { requestId: string; url: string } | undefined;
    const bridge = new DouyinBridge((event) => { if (event.type === "douyin.bridge.request") request = event; });
    const result = bridge.request("https://www.douyin.com/video/123");
    expect(request?.url).toBe("https://www.douyin.com/video/123");
    expect(bridge.handleResponse({
      type: "douyin.bridge.response",
      requestId: request!.requestId,
      ok: true,
      result: JSON.stringify({ videoUrl: "https://v.douyinvod.com/video.mp4", pageUrl: request!.url }),
    })).toBe(true);
    await expect(result).resolves.toEqual({ videoUrl: "https://v.douyinvod.com/video.mp4", pageUrl: request!.url });
  });

  test("rejects a response for a different work and cancels only the aborted request", async () => {
    const events: Array<{ type: string; requestId: string }> = [];
    const bridge = new DouyinBridge((event) => events.push(event));
    const first = bridge.request("https://www.douyin.com/video/123");
    bridge.handleResponse({ type: "douyin.bridge.response", requestId: events[0]!.requestId, ok: true,
      result: JSON.stringify({ videoUrl: "https://v.douyinvod.com/wrong.mp4", pageUrl: "https://www.douyin.com/video/456" }) });
    await expect(first).rejects.toMatchObject({ code: "douyin-bridge.content_mismatch" });
    const controller = new AbortController();
    const second = bridge.request("https://www.douyin.com/video/123", controller.signal);
    const requestId = events.at(-1)!.requestId;
    controller.abort();
    await expect(second).rejects.toMatchObject({ code: "douyin-bridge.download_cancelled" });
    expect(events.at(-1)).toEqual({ type: "douyin.bridge.cancel", requestId });
    expect(bridge.handleResponse({ type: "douyin.bridge.response", requestId, ok: false })).toBe(false);
  });

  test("author requests validate homepage identity and every work before resolving", async () => {
    let request: { requestId: string; operation?: string; limit?: number } | undefined;
    const bridge = new DouyinBridge((event) => { if (event.type === "douyin.bridge.request") request = event; });
    const url = "https://www.douyin.com/user/MS4w-test";
    const first = bridge.listAuthor(url, 10);
    expect(request).toMatchObject({ operation: "author", limit: 10 });
    bridge.handleResponse({ type: "douyin.bridge.response", requestId: request!.requestId, ok: true,
      result: JSON.stringify({ pageUrl: url, authorId: "MS4w-test", nickname: "Creator", videos: [], completion: "exhausted" }) });
    await expect(first).resolves.toMatchObject({ completion: "exhausted" });
    const second = bridge.listAuthor(url, 1);
    bridge.handleResponse({ type: "douyin.bridge.response", requestId: request!.requestId, ok: true,
      result: JSON.stringify({ pageUrl: url, authorId: "MS4w-test", nickname: "Creator", completion: "limit",
        videos: [{ contentId: "123", authorId: "other", url: "https://www.douyin.com/video/123", description: "", createdAt: 0, pinned: false }] }) });
    await expect(second).rejects.toMatchObject({ code: "douyin-bridge.invalid_author_result" });
    expect(() => bridge.listAuthor("https://www.douyin.com/video/123", 10)).toThrow();
    expect(() => bridge.listAuthor(url, 1.5)).toThrow();
  });

  test("video and short-link owner requests reject mismatched detail metadata", async () => {
    let request: { requestId: string; operation?: string } | undefined;
    const bridge = new DouyinBridge((event) => { if (event.type === "douyin.bridge.request") request = event; });
    const payload = { videoPageUrl: "https://www.douyin.com/video/123", contentId: "123", authorId: "MS4w-test",
      profileUrl: "https://www.douyin.com/user/MS4w-test", nickname: "Creator" };
    const first = bridge.resolveAuthor("https://v.douyin.com/share/");
    expect(request?.operation).toBe("owner");
    bridge.handleResponse({ type: "douyin.bridge.response", requestId: request!.requestId, ok: true, result: JSON.stringify(payload) });
    await expect(first).resolves.toEqual(payload);
    const second = bridge.resolveAuthor("https://www.douyin.com/video/456");
    bridge.handleResponse({ type: "douyin.bridge.response", requestId: request!.requestId, ok: true, result: JSON.stringify(payload) });
    await expect(second).rejects.toMatchObject({ code: "douyin-bridge.invalid_author_result" });
  });
});

test("bridge preserves CDN candidates and structured failure scope without reading message text", async () => {
  let requestId = "";
  const bridge = new DouyinBridge((event) => { if (event.type === "douyin.bridge.request") requestId = event.requestId; });
  const url = "https://www.douyin.com/video/123";
  const videoUrls = ["https://v.douyinvod.com/media.mp4", "https://v.douyinvod.com/mirror.mp4"];
  const first = bridge.request(url);
  bridge.handleResponse({ type: "douyin.bridge.response", requestId, ok: true, result: JSON.stringify({ pageUrl: url, videoUrl: videoUrls[0], videoUrls }) });
  await expect(first).resolves.toMatchObject({ videoUrls });
  const failed = bridge.request(url);
  bridge.handleResponse({ type: "douyin.bridge.response", requestId, ok: false, failure: "work_unavailable", message: "unavailable" });
  await expect(failed).rejects.toBeInstanceOf(DouyinBridgeError);
  await expect(failed).rejects.toMatchObject({ failure: "work_unavailable" });
});
