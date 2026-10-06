import { expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { douyinAuthorId, isDouyinAuthorResult } from "@qone/protocol";
import { DOUYIN_AUTHOR_SNAPSHOT, douyinAuthorObserver, resolveDouyinAuthorPage } from "../src/lib/douyin-author-page";
import { resolveDouyinPage } from "../src/lib/douyin-page-bridge";
import { rememberDouyinPlaybacks } from "../src/lib/douyin-video-page";

const authorId = "MS4w-test";
const url = `https://www.douyin.com/user/${authorId}`;
const video = (id: string, owner = authorId) => ({ aweme_id: id, author: { sec_uid: owner, nickname: "Creator" }, video: {}, desc: "Title", create_time: 123, is_top: 1 });
const api = (cursor: string, owner = authorId) => `https://www.douyin.com/aweme/v1/web/aweme/post/?sec_user_id=${owner}&max_cursor=${cursor}`;

test("creator observer orders cursor pages, excludes other feeds/authors/images and deduplicates long IDs", async () => {
  const dom = new JSDOM("", { url, runScripts: "outside-only" });
  const replies = new Map<string, unknown>();
  const window = dom.window;
  Object.defineProperty(window, "fetch", { value: async (input: string) => new Response(JSON.stringify(replies.get(input))), writable: true });
  // No browser is launched. Only run the injected script in a synthetic document.
  window.eval(douyinAuthorObserver(authorId, 3));
  const first = "7123456789012345678";
  replies.set(api("1"), { aweme_list: [video(first), video("333")], has_more: 0, max_cursor: 2 });
  replies.set(api("0"), { status_code: 0, aweme_list: [video(first), video("222"), video("wrong", "other"),
    { ...video("444"), images: [{}] }], has_more: 1, max_cursor: 1 });
  replies.set(api("0", "other"), { aweme_list: [video("555")], has_more: 0 });
  try {
    await window.fetch(api("0", "other"));
    await window.fetch(api("1"));
    await window.fetch(api("0"));
    // Wait for the response clones, not a live page load.
    await new Promise((resolve) => setTimeout(resolve, 0));
    const result = JSON.parse(window.eval(DOUYIN_AUTHOR_SNAPSHOT));
    expect(result.videos.map((item: { contentId: string }) => item.contentId)).toEqual([first, "222", "333"]);
    expect(result.videos[0].pinned).toBe(true);
    expect(result.completion).toBe("limit");
    expect(isDouyinAuthorResult(result, url, 3)).toBe(true);
    expect(isDouyinAuthorResult({ ...result, authorId: "other" }, url, 3)).toBe(false);
    expect(isDouyinAuthorResult({ ...result, videos: [result.videos[0], result.videos[0]] }, url, 3)).toBe(false);
  } finally { window.close(); }
});

test("XHR post responses capture exhausted empty profiles", () => {
  const dom = new JSDOM("", { url, runScripts: "outside-only" });
  class Xhr extends dom.window.EventTarget {
    responseType = "json";
    status = 200;
    response: unknown = { aweme_list: [], has_more: 0 };
    open(..._args: unknown[]) {}
    send() { this.dispatchEvent(new dom.window.Event("loadend")); }
  }
  Object.defineProperty(dom.window, "XMLHttpRequest", { value: Xhr });
  dom.window.eval(douyinAuthorObserver(authorId, 10));
  try {
    const xhr = new Xhr();
    xhr.open("GET", api("0"));
    xhr.send();
    const result = JSON.parse(dom.window.eval(DOUYIN_AUTHOR_SNAPSHOT));
    expect(result.completion).toBe("exhausted");
    expect(result.videos).toEqual([]);
    expect(douyinAuthorId("https://www.douyin.com/user/self")).toBeUndefined();
    expect(douyinAuthorId("https://douyin.com.evil.test/user/MS4w-test")).toBeUndefined();
  } finally { dom.window.close(); }
});

test("author requests install observation before navigation and close their own page on completion/cancel", async () => {
  const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
  const payload = { pageUrl: url, authorId, nickname: "Creator", videos: [], completion: "exhausted" };
  const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, args });
    return (command === "browser_eval_result" ? JSON.stringify(JSON.stringify(payload)) : undefined) as T;
  };
  expect(JSON.parse(await resolveDouyinAuthorPage(invoke, { requestId: "list", url, limit: 10 }, new AbortController().signal))).toMatchObject(payload);
  expect(calls[0]?.args.initializationScript).toBe(douyinAuthorObserver(authorId, 10));
  expect(calls.at(-1)).toMatchObject({ command: "browser_close", args: { browserId: "douyin-author-list" } });
  const controller = new AbortController();
  const aborting = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    if (command === "browser_eval_result") controller.abort();
    return invoke<T>(command, args);
  };
  await expect(resolveDouyinAuthorPage(aborting, { requestId: "cancel", url, limit: 10 }, controller.signal)).rejects.toThrow();
  expect(calls.at(-1)?.args.browserId).toBe("douyin-author-cancel");
});

test("author timeout cannot relabel the last list as a complete batch", async () => {
  let tick = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => ++tick < 4 ? 0 : 100_000);
  let closed = false;
  const payload = { pageUrl: url, authorId, nickname: "Creator", videos: [{ contentId: "123", authorId, url: "https://www.douyin.com/video/123", description: "", createdAt: 0, pinned: false }], completion: "limit" };
  const invoke = async <T>(command: string): Promise<T> => {
    if (command === "browser_close") closed = true;
    return (command === "browser_eval_result" ? JSON.stringify(JSON.stringify(payload)) : undefined) as T;
  };
  try {
    const result = JSON.parse(await resolveDouyinAuthorPage(invoke, { requestId: "timeout", url, limit: 1 }, new AbortController().signal));
    expect(result.completion).toBe("timeout");
    expect(result.videos).toHaveLength(1);
    expect(closed).toBe(true);
  } finally { clock.mockRestore(); }
});

test("creator post playback survives page closure privately and batch downloads need no player pages", async () => {
  const dom = new JSDOM("", { url, runScripts: "outside-only" });
  const item = { ...video("7123456789012345678"), video: { play_addr: { url_list: ["https://v.douyinvod.com/media.mp4?signature=private"] } } };
  Object.defineProperty(dom.window, "fetch", { writable: true, value: async () => new Response(JSON.stringify({ aweme_list: [item], has_more: 0 })) });
  dom.window.eval(douyinAuthorObserver(authorId, 1));
  try {
    await dom.window.fetch(api("0"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const snapshot = dom.window.eval(DOUYIN_AUTHOR_SNAPSHOT);
    const invoke = async <T>(command: string): Promise<T> => (command === "browser_eval_result" ? JSON.stringify(snapshot) : undefined) as T;
    const metadata = await resolveDouyinAuthorPage(invoke, { requestId: "cached", url, limit: 1 }, new AbortController().signal);
    expect(metadata).not.toContain("signature");
    expect(metadata).not.toContain("playbacks");
    dom.window.close();
    const neverOpen = async <T>(): Promise<T> => { throw new Error("should use verified post data, not open another page"); };
    const result = JSON.parse(await resolveDouyinPage(neverOpen, { requestId: "save", url: JSON.parse(metadata).videos[0].url }, new AbortController().signal));
    expect(result.contentId).toBe(item.aweme_id);
    expect(result.videoUrl).toBe(item.video.play_addr.url_list[0]);
    expect(result.videoUrls).toEqual(item.video.play_addr.url_list);
  } finally {
    rememberDouyinPlaybacks({ pageUrl: url, authorId, nickname: "", videos: [], completion: "exhausted" }, []);
    dom.window.close();
  }
});
