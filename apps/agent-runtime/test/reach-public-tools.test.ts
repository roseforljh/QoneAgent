import { afterEach, describe, expect, test } from "bun:test";
import { createReachPublicTools, parseFeed } from "../src/reach-public-tools";
import { listReachChannels } from "../src/reach-channels";
import { fetchWebContent } from "../src/web-fetch";
import { browserScreenshotResult } from "../src/web-image";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("Agent Reach channels", () => {
  const publicLookup = async () => [{ address: "93.184.216.34", family: 4 }];

  test("exposes public web routing guidance on the generic and GitHub tools", () => {
    const tools = createReachPublicTools({ ytDlp: () => undefined });
    expect(tools.find((tool) => tool.name === "web_fetch")?.promptSnippet).toContain("prefer web_fetch");
    expect(tools.find((tool) => tool.name === "web_fetch")?.promptSnippet).toContain("do not retry the same URL with shell commands");
    expect(tools.find((tool) => tool.name === "web_fetch")?.promptSnippet).toContain("qone_browser_open");
    expect(tools.find((tool) => tool.name === "web_fetch")?.promptSnippet).toContain("qone_browser_extract");
    expect(tools.find((tool) => tool.name === "web_fetch")?.promptSnippet).toContain("recursively fetch relevant cited pages");
    expect(tools.find((tool) => tool.name === "web_fetch")?.description).toContain("linked sources");
    expect(tools.find((tool) => tool.name === "qone_github_public")?.description).toContain("For a public GitHub URL");
  });

  test("fetches HTML locally and extracts the main article as Markdown", async () => {
    const result = await fetchWebContent("https://example.com/article", {
      lookup: publicLookup,
      fetchImpl: async () => new Response("<!doctype html><html><head><title>Demo</title></head><body><nav>Navigation noise</nav><article><h1>Heading</h1><p>This is article content with enough text for the local extractor to keep the main article body.</p></article><footer>Footer noise</footer></body></html>", { headers: { "content-type": "text/html; charset=utf-8" } }),
    });
    expect(result).toMatchObject({ finalUrl: "https://example.com/article", status: 200, contentType: "text/html", title: "Demo", truncated: false });
    expect(result.content).toContain("## Heading");
    expect(result.content).not.toContain("Navigation noise");
    expect(result.content).not.toContain("Footer noise");
  });

  test("returns Markdown and plain text without HTML extraction", async () => {
    const markdown = await fetchWebContent("https://example.com/readme.md", {
      lookup: publicLookup,
      fetchImpl: async () => new Response("# Read me\n\nText", { headers: { "content-type": "text/markdown" } }),
    });
    expect(markdown.content).toBe("# Read me\n\nText");
    expect(markdown.title).toBe("Read me");
    const raw = await fetchWebContent("https://example.com/page", {
      mode: "raw",
      lookup: publicLookup,
      fetchImpl: async () => new Response("<html><head><title>Raw</title></head><body><p>Raw HTML</p></body></html>", { headers: { "content-type": "text/html" } }),
    });
    expect(raw.content).toContain("Raw HTML");
    expect(raw.title).toBe("Raw");
  });

  test("follows redirects and validates every redirect target", async () => {
    const requested: string[] = [];
    const result = await fetchWebContent("https://example.com/start", {
      lookup: publicLookup,
      fetchImpl: async (url) => {
        requested.push(String(url));
        return requested.length === 1
          ? new Response(null, { status: 302, headers: { Location: "/final" } })
          : new Response("done", { headers: { "content-type": "text/plain" } });
      },
    });
    expect(requested).toEqual(["https://example.com/start", "https://example.com/final"]);
    expect(result.finalUrl).toBe("https://example.com/final");
  });

  test("returns 404 metadata, enforces max_chars, and reports timeout", async () => {
    const notFound = await fetchWebContent("https://example.com/missing", {
      lookup: publicLookup,
      fetchImpl: async () => new Response("missing", { status: 404, headers: { "content-type": "text/plain" } }),
    });
    expect(notFound).toMatchObject({ status: 404, content: "missing", truncated: false });
    const long = await fetchWebContent("https://example.com/long", {
      maxChars: 10,
      lookup: publicLookup,
      fetchImpl: async () => new Response("0123456789abcdefghij", { headers: { "content-type": "text/plain" } }),
    });
    expect(long).toMatchObject({ content: "0123456789", truncated: true });
    await expect(fetchWebContent("https://example.com/slow", {
      timeout: 10,
      lookup: publicLookup,
      fetchImpl: async (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new DOMException("The operation was aborted", "AbortError")), { once: true });
      }),
    })).rejects.toThrow("超时");
  });

  test("returns valid public images as visual input and rejects invalid image bytes", async () => {
    const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");
    const result = await fetchWebContent("https://example.com/image", {
      lookup: publicLookup,
      fetchImpl: async () => new Response(png, { headers: { "content-type": "image/png" } }),
    });
    expect(result).toMatchObject({ contentType: "image/png", content: "Image attached for visual inspection." });
    expect(result.image).toMatchObject({ type: "image", mimeType: "image/png" });
    await expect(fetchWebContent("https://example.com/invalid-image", {
      lookup: publicLookup,
      fetchImpl: async () => new Response("image", { headers: { "content-type": "image/png" } }),
    })).rejects.toThrow("Unsupported or invalid image response");
  });

  test("converts an OpenCLI screenshot into visual input", () => {
    const result = browserScreenshotResult("data:image/png;base64,\n iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  test("blocks private addresses, private redirects, malformed URLs, and unsupported binary responses", async () => {
    await expect(fetchWebContent("http://127.0.0.1/private", { fetchImpl: async () => new Response() })).rejects.toThrow("私有网络");
    await expect(fetchWebContent("https://example.com/private", {
      lookup: async () => [{ address: "10.0.0.8", family: 4 }],
      fetchImpl: async () => new Response(),
    })).rejects.toThrow("私有网络");
    await expect(fetchWebContent("https://example.com/redirect", {
      lookup: publicLookup,
      fetchImpl: async () => new Response(null, { status: 302, headers: { Location: "http://127.0.0.1/admin" } }),
    })).rejects.toThrow("私有网络");
    await expect(fetchWebContent("file:///secret", { fetchImpl: async () => new Response() })).rejects.toThrow("公开网站");
    await expect(fetchWebContent("https://example.com/image", {
      lookup: publicLookup,
      fetchImpl: async () => new Response("binary", { headers: { "content-type": "application/octet-stream" } }),
    })).rejects.toThrow("不支持的网站内容类型");
  });

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

  test("never forwards credentials to a different origin after a redirect", async () => {
    for (const [name, toolName, args, options] of [
      ["GitHub token", "qone_github_public", { kind: "repo", value: "owner/repo" }, { githubToken: () => "secret-token" }],
      ["Xueqiu cookie", "qone_xueqiu", { kind: "quote", value: "SH600519" }, { xueqiuCookie: () => "secret-cookie" }],
    ] as const) {
      let calls = 0;
      globalThis.fetch = (async () => {
        calls++;
        return new Response(null, { status: 302, headers: { Location: "https://other.example.org/collect" } });
      }) as typeof fetch;
      const tool = createReachPublicTools({ ytDlp: () => undefined, ...options }).find((item) => item.name === toolName)!;
      await expect(tool.execute("test", args, undefined as never, undefined as never)).rejects.toThrow("不能跨站重定向");
      expect(calls).toBe(1);
    }
  });

  test("rejects local RSS URLs and redirects to local addresses", async () => {
    const tool = createReachPublicTools({ ytDlp: () => undefined }).find((item) => item.name === "qone_rss_read")!;
    await expect(tool.execute("test", { url: "http://127.0.0.1/private" }, undefined as never, undefined as never)).rejects.toThrow("公开网站");
    globalThis.fetch = (async () => new Response(null, { status: 302, headers: { Location: "http://localhost/private" } })) as typeof fetch;
    await expect(tool.execute("test", { url: "https://example.com/feed" }, undefined as never, undefined as never)).rejects.toThrow("公开网站");
  });
});
