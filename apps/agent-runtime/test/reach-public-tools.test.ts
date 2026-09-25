import { afterEach, describe, expect, test } from "bun:test";
import { createReachPublicTools, parseFeed } from "../src/reach-public-tools";
import { listReachChannels } from "../src/reach-channels";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Agent Reach channels", () => {
  test("parses RSS and Atom links without mixing entries", () => {
    expect(parseFeed('<rss><channel><item><title>News</title><link>https://example.com/1</link><pubDate>Today</pubDate></item></channel></rss>')).toEqual([
      { title: "News", url: "https://example.com/1", published: "Today", summary: undefined },
    ]);
    expect(parseFeed('<feed><entry><title>Post</title><link rel="alternate" href="https://example.com/2"/></entry></feed>')[0]?.url).toBe("https://example.com/2");
  });

  test("publishes 16 honest channel states and registers only installed CLI tools", () => {
    const channels = listReachChannels({ browserConnected: false, mcpConnected: () => false });
    expect(channels).toHaveLength(16);
    expect(channels.find((channel) => channel.id === "web")?.state).toBe("available");
    expect(channels.find((channel) => channel.id === "boss")?.state).toBe("needs-connection");
    expect(channels.find((channel) => channel.id === "twitter")?.state).toBe("needs-connection");
    expect(createReachPublicTools({ ytDlp: () => undefined }).some((tool) => tool.name === "qone_youtube")).toBe(false);
  });

  test("public GitHub route makes a direct API request and returns data", async () => {
    let requested: string | undefined;
    globalThis.fetch = (async (url: string | URL) => {
      requested = String(url);
      return new Response(JSON.stringify({ full_name: "owner/repo" }), { headers: { "Content-Type": "application/json" } });
    }) as typeof fetch;
    const tool = createReachPublicTools({ ytDlp: () => undefined }).find((item) => item.name === "qone_github_public")!;
    const result = await tool.execute("test", { kind: "repo", value: "owner/repo" }, undefined as never, undefined as never);
    expect(requested).toBe("https://api.github.com/repos/owner/repo");
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("owner/repo") });
  });

  test("Xueqiu route uses the configured cookie only for the fixed API host", async () => {
    let requested = "";
    let sentCookie = "";
    globalThis.fetch = (async (url: string | URL, init?: RequestInit) => {
      requested = String(url);
      sentCookie = String((init?.headers as Record<string, string>)?.Cookie ?? "");
      return new Response(JSON.stringify({ data: { quote: { symbol: "SH600519" } } }));
    }) as typeof fetch;
    const tool = createReachPublicTools({ ytDlp: () => undefined, xueqiuCookie: () => "xq_a_token=test" }).find((item) => item.name === "qone_xueqiu")!;
    const result = await tool.execute("test", { kind: "quote", value: "SH600519" }, undefined as never, undefined as never);
    expect(requested).toBe("https://stock.xueqiu.com/v5/stock/quote.json?symbol=SH600519&extend=detail");
    expect(sentCookie).toBe("xq_a_token=test");
    expect(result.content[0]).toMatchObject({ text: expect.stringContaining("SH600519") });
    await expect(tool.execute("test", { kind: "quote", value: "https://evil.test/" }, undefined as never, undefined as never)).rejects.toThrow("格式无效");
  });

  test("rejects local RSS URLs and redirects to local addresses", async () => {
    const tool = createReachPublicTools({ ytDlp: () => undefined }).find((item) => item.name === "qone_rss_read")!;
    await expect(tool.execute("test", { url: "http://127.0.0.1/private" }, undefined as never, undefined as never)).rejects.toThrow("公开网站");
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: "http://localhost/private" } })) as typeof fetch;
    await expect(tool.execute("test", { url: "https://example.com/feed" }, undefined as never, undefined as never)).rejects.toThrow("公开网站");
  });
});
