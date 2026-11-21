import { describe, expect, mock, test } from "bun:test";
import * as dns from "node:dns/promises";

// The SSRF guard runs before the injected HTTP transport.
mock.module("node:dns/promises", () => ({ ...dns, lookup: async () => [{ address: "140.82.112.6", family: 4 }] }));
const { createReachPublicTools, parseFeed } = await import("../src/reach-public-tools");
import { listReachChannels } from "../src/reach-channels";
import { browserScreenshotResult } from "../src/web-image";

const transport = (respond: (url: URL) => Response) => async (url: URL) => ({ response: respond(url), release: async () => {} });

describe("Agent Reach channels", () => {
  test("converts an OpenCLI screenshot into visual input", () => {
    const result = browserScreenshotResult("data:image/png;base64,\n iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=");
    expect(result.content[1]).toMatchObject({ type: "image", mimeType: "image/png" });
  });

  test("parses RSS and Atom links without mixing entries", () => {
    expect(parseFeed('<rss><channel><item><title>News</title><link>https://example.com/1</link><pubDate>Today</pubDate></item></channel></rss>')).toEqual([
      { title: "News", url: "https://example.com/1", published: "Today", summary: undefined },
    ]);
    expect(parseFeed('<feed><entry><title>Post</title><link rel="alternate" href="https://example.com/2"/></entry></feed>')[0]?.url).toBe("https://example.com/2");
  });

  test("publishes honest channel states and registers only installed CLI tools", () => {
    const channels = listReachChannels({ browserConnected: false, mcpConnected: () => false });
    expect(channels).toHaveLength(16);
    expect(channels.find((channel) => channel.id === "boss")?.state).toBe("needs-connection");
    expect(channels.find((channel) => channel.id === "twitter")?.state).toBe("needs-connection");
    expect(createReachPublicTools({ ytDlp: () => undefined }).some((tool) => tool.name === "qone_youtube_search")).toBe(false);
    expect(listReachChannels({ browserConnected: false, mcpConnected: () => false }).find((channel) => channel.id === "youtube")?.tools).not.toContain("qone_youtube");
  });

  test("installed YouTube search exposes no duplicate single-video inspection route", () => {
    const tools = createReachPublicTools({ ytDlp: () => "yt-dlp" });
    expect(tools.some((tool) => tool.name === "qone_youtube")).toBe(false);
    const search = tools.find((tool) => tool.name === "qone_youtube_search")!;
    expect(search.parameters.required).toEqual(["query"]);
    expect(search.parameters.properties).not.toHaveProperty("kind");
  });

  test("public GitHub route makes a direct API request and returns data", async () => {
    let requested: string | undefined;
    const tool = createReachPublicTools({ ytDlp: () => undefined, transport: transport(url => {
      requested = String(url);
      return new Response(JSON.stringify({ full_name: "owner/repo" }), { headers: { "Content-Type": "application/json" } });
    }) }).find((item) => item.name === "qone_github_public")!;
    const result = await tool.execute("test", { kind: "repo", value: "owner/repo" }, undefined as never, undefined as never);
    expect(requested).toBe("https://api.github.com/repos/owner/repo");
    expect(result.content[0]).toMatchObject({ type: "text", text: expect.stringContaining("owner/repo") });
  });

  test("never forwards credentials to a different origin after a redirect", async () => {
    for (const [name, toolName, args, options] of [
      ["GitHub token", "qone_github_public", { kind: "repo", value: "owner/repo" }, { githubToken: () => "secret-token" }],
    ] as const) {
      let calls = 0;
      const tool = createReachPublicTools({ ytDlp: () => undefined, ...options, transport: transport(() => {
        calls++;
        return new Response(null, { status: 302, headers: { Location: "https://other.example.org/collect" } });
      }) }).find((item) => item.name === toolName)!;
      await expect(tool.execute("test", args, undefined as never, undefined as never)).rejects.toThrow("不能跨站重定向");
      expect(calls).toBe(1);
    }
  });

  test("rejects local RSS URLs and redirects to local addresses", async () => {
    const tool = createReachPublicTools({ ytDlp: () => undefined, transport: transport(() => new Response(null, { status: 302, headers: { Location: "http://localhost/private" } })) }).find((item) => item.name === "qone_rss_read")!;
    await expect(tool.execute("test", { url: "http://127.0.0.1/private" }, undefined as never, undefined as never)).rejects.toThrow("公开网站");
    await expect(tool.execute("test", { url: "https://example.com/feed" }, undefined as never, undefined as never)).rejects.toThrow("公开网站");
  });
});
