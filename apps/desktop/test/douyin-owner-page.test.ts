import { expect, test } from "bun:test";
import { JSDOM } from "jsdom";
import { isDouyinOwnerResult } from "@qone/protocol";
import { douyinOwnerObserver } from "../src/lib/douyin-author-page";
import { douyinOwnerScript } from "../src/lib/douyin-owner-page";
import { resolveDouyinPage } from "../src/lib/douyin-page-bridge";

const url = "https://www.douyin.com/video/7123456789012345678";
const id = "7123456789012345678";
const item = { aweme_id: id, author: { sec_uid: "MS4w-creator", nickname: "Creator" } };

test("creator identity comes only from the matching work, not recommended profile links", () => {
  const html = `<a href="/user/other">Other</a><script type="application/json">${JSON.stringify([
    { aweme_id: "456", author: { sec_uid: "other" } }, item,
  ])}</script>`;
  const dom = new JSDOM(html, { url, runScripts: "outside-only" });
  try {
    const result = JSON.parse(dom.window.eval(douyinOwnerScript(url)));
    expect(result.authorId).toBe("MS4w-creator");
    expect(isDouyinOwnerResult(result, url)).toBe(true);
    expect(isDouyinOwnerResult(result, "https://www.douyin.com/video/456")).toBe(false);
    expect(isDouyinOwnerResult({ ...result, profileUrl: "https://douyin.com.evil.test/user/MS4w-creator" }, url)).toBe(false);
  } finally { dom.window.close(); }
});

test("short-link creator lookup observes detail responses and closes only its embedded page", async () => {
  const dom = new JSDOM("", { url, runScripts: "outside-only" });
  const short = "https://v.douyin.com/share/";
  Object.defineProperty(dom.window, "fetch", { writable: true, value: async () => new Response(JSON.stringify({ aweme_detail: item })) });
  dom.window.eval(douyinOwnerObserver(short));
  try {
    await dom.window.fetch(`https://www.douyin.com/aweme/v1/web/aweme/detail/?aweme_id=${id}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const value = dom.window.eval(douyinOwnerScript(short));
    const calls: Array<{ command: string; args: Record<string, unknown> }> = [];
    const invoke = async <T>(command: string, args: Record<string, unknown>): Promise<T> => {
      calls.push({ command, args });
      return (command === "browser_eval_result" ? JSON.stringify(value) : undefined) as T;
    };
    const result = JSON.parse(await resolveDouyinPage(invoke, { requestId: "lookup", url: short, operation: "owner" }, new AbortController().signal));
    expect(result.profileUrl).toBe("https://www.douyin.com/user/MS4w-creator");
    expect(calls[0]?.args.initializationScript).toBe(douyinOwnerObserver(short));
    expect(calls.at(-1)).toMatchObject({ command: "browser_close", args: { browserId: "douyin-owner-lookup" } });
  } finally { dom.window.close(); }
});
