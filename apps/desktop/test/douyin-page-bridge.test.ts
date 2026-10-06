import { expect, spyOn, test } from "bun:test";
import { JSDOM } from "jsdom";
import { douyinContentId } from "@qone/protocol";
import { douyinVideoUrlScript, isDouyinBridgeResult, resolveDouyinPage } from "../src/lib/douyin-page-bridge";
import { douyinOwnerObserver } from "../src/lib/douyin-author-page";

const target = "https://www.douyin.com/video/123";
const correct = { videoUrl: "https://v.douyinvod.com/target.mp4", pageUrl: target, contentId: "123" };

function probe(pageUrl: string, html: string) {
  const dom = new JSDOM(html, { url: pageUrl, runScripts: "outside-only" });
  try { return JSON.parse(dom.window.eval(douyinVideoUrlScript(target))); }
  finally { dom.window.close(); }
}

test("probe binds embedded playback metadata to the requested ID and ignores global MP4s", () => {
  const items = [
    { aweme_id: "456", video: { play_addr: { url_list: ["https://v.douyinvod.com/wrong.mp4"] } } },
    { aweme_id: "123", video: { play_addr: { url_list: [correct.videoUrl] } } },
  ];
  const html = `<script type="application/json">${JSON.stringify(items)}</script>`;
  expect(probe(target, html).videoUrl).toBe(correct.videoUrl);
  expect(probe("https://www.douyin.com/video/456", html).videoUrl).toBeUndefined();
  expect(probe("https://www.douyin.com/", html).videoUrl).toBeUndefined();
  expect(probe(target, '<script>"https://v.douyinvod.com/promotion.mp4"</script>').videoUrl).toBe("");
});

test("share and modal URLs preserve IDs and invalid page identity is rejected", () => {
  expect(douyinContentId("https://www.iesdouyin.com/share/video/7123456789012345678/")).toBe("7123456789012345678");
  expect(douyinContentId("https://www.douyin.com/?modal_id=123")).toBe("123");
  expect(douyinContentId("https://douyin.com.evil.test/video/123")).toBeUndefined();
  expect(douyinContentId("file://www.douyin.com/video/123")).toBeUndefined();
  expect(isDouyinBridgeResult(correct, target)).toBe(true);
  expect(isDouyinBridgeResult({ ...correct, pageUrl: "https://www.douyin.com/video/456" }, target)).toBe(false);
  expect(isDouyinBridgeResult({ ...correct, contentId: "456" }, target)).toBe(false);
});

test("isolated requests retry navigation null and wrong work, then close their own page", async () => {
  const calls: Array<{ command: string; browserId: unknown }> = [];
  const counts = new Map<unknown, number>();
  const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    calls.push({ command, browserId: args.browserId });
    if (command !== "browser_eval_result") return undefined as T;
    const count = counts.get(args.browserId) ?? 0;
    counts.set(args.browserId, count + 1);
    return JSON.stringify(count === 0 ? null : JSON.stringify(correct)) as T;
  };
  const controller = new AbortController();
  const result = await Promise.all(["one", "two"].map((requestId) => resolveDouyinPage(invoke, { requestId, url: target }, controller.signal)));
  expect(result.map((raw) => JSON.parse(raw).videoUrl)).toEqual([correct.videoUrl, correct.videoUrl]);
  expect(calls.filter((call) => call.command === "browser_open").map((call) => call.browserId)).toEqual(["douyin-video-one", "douyin-video-two"]);
  expect(calls.filter((call) => call.command === "browser_close")).toHaveLength(2);
  expect(calls.some((call) => call.browserId === "auth-page-douyin")).toBe(false);
});

test("deadline rejects even a usable last payload and releases the page", async () => {
  let nowCalls = 0;
  const clock = spyOn(Date, "now").mockImplementation(() => ++nowCalls < 3 ? 0 : 40_000);
  const closed: unknown[] = [];
  const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
    if (command === "browser_close") closed.push(args.browserId);
    return (command === "browser_eval_result" ? JSON.stringify(JSON.stringify(correct)) : undefined) as T;
  };
  try {
    await expect(resolveDouyinPage(invoke, { requestId: "expired", url: target }, new AbortController().signal)).rejects.toThrow();
    expect(closed).toEqual(["douyin-video-expired"]);
  } finally { clock.mockRestore(); }
});

test("a blob player without SSR data resolves the verified dynamic detail response, never another work", async () => {
  const dom = new JSDOM('<video src="blob:https://www.douyin.com/player"></video>', { url: target, runScripts: "outside-only" });
  let item = { aweme_id: "456", video: { play_addr: { url_list: ["https://v.douyinvod.com/wrong.mp4"] } } };
  Object.defineProperty(dom.window, "fetch", { writable: true, value: async (input: string) => input.includes("aweme_id=456")
    ? new Response("unrelated failed response", { status: 500 }) : new Response(JSON.stringify({ status_code: 0, aweme_detail: item })) });
  dom.window.eval(douyinOwnerObserver(target));
  const detail = "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123";
  try {
    await dom.window.fetch(detail.replace("aweme_id=123", "aweme_id=456"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(dom.window.eval(douyinVideoUrlScript(target))).failure).toBeUndefined();
    await dom.window.fetch(detail);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(JSON.parse(dom.window.eval(douyinVideoUrlScript(target))).videoUrl).toBe("");
    item = { aweme_id: "123", video: { play_addr: { url_list: [correct.videoUrl, "https://v.douyinvod.com/mirror.mp4"] } } };
    await dom.window.fetch(detail);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const payload = JSON.parse(dom.window.eval(douyinVideoUrlScript(target)));
    expect(payload).toMatchObject(correct);
    expect(payload.videoUrls).toHaveLength(2);
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      return (command === "browser_eval_result" ? JSON.stringify(JSON.stringify(payload)) : undefined) as T;
    };
    await expect(resolveDouyinPage(invoke, { requestId: "dynamic", url: target }, new AbortController().signal)).resolves.toBe(JSON.stringify(payload));
    expect(calls[0]?.args.initializationScript).toBe(douyinOwnerObserver(target));
    expect(calls.at(-1)?.command).toBe("browser_close");
  } finally { dom.window.close(); }
});

test("XHR detail errors return structured failures and close the request page immediately", async () => {
  const dom = new JSDOM("", { url: target, runScripts: "outside-only" });
  class Xhr extends dom.window.EventTarget {
    responseType = "json";
    status = 403;
    response: unknown = { status_code: 1 };
    open(..._args: unknown[]) {}
    send() { this.dispatchEvent(new dom.window.Event("loadend")); }
  }
  Object.defineProperty(dom.window, "XMLHttpRequest", { value: Xhr });
  dom.window.eval(douyinOwnerObserver(target));
  try {
    const xhr = new Xhr();
    xhr.open("GET", "https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=123");
    xhr.send();
    const raw = JSON.stringify(dom.window.eval(douyinVideoUrlScript(target)));
    expect(JSON.parse(JSON.parse(raw)).failure).toBe("page_unavailable");
    let closed = false;
    const invoke = async <T>(command: string): Promise<T> => {
      if (command === "browser_close") closed = true;
      return (command === "browser_eval_result" ? raw : undefined) as T;
    };
    await expect(resolveDouyinPage(invoke, { requestId: "blocked", url: target }, new AbortController().signal)).rejects.toMatchObject({ failure: "page_unavailable" });
    expect(closed).toBe(true);
  } finally { dom.window.close(); }
});
