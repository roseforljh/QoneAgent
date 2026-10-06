import { describe, expect, test } from "bun:test";
import { WebAccessMemory } from "../src/web-access-memory";

function store() {
  const values = new Map<string, unknown>();
  return {
    values,
    get: <T>(key: string) => values.get(key) as T | undefined,
    set: (key: string, value: unknown) => values.set(key, value),
  };
}

describe("WebAccessMemory", () => {
  test("old Douyin Chrome successes cannot force the obsolete backend", () => {
    const memory = new WebAccessMemory(store());
    const context = memory.context("session-douyin", "下载抖音视频", [
      { toolName: "qone_browser_open", args: { url: "https://v.douyin.com/share/" }, result: { content: [] }, at: 1 },
      { toolName: "qone_opencli_run", args: { site: "douyin", command: "search" }, result: { content: [] }, at: 2 },
    ]);
    expect(context).toContain("MUST use Qone embedded Douyin bridge");
    expect(context).not.toContain("MUST use OpenCLI");
    expect(context).toContain("qone_douyin_resolve_author");
  });
  test("remembers a failed direct route and a successful browser route per session", () => {
    const memory = new WebAccessMemory(store());
    memory.recordToolResult("session-a", "web_fetch", { url: "https://www.nodeseek.com/post-1" }, {
      details: { status: 403, content: "blocked" },
    });
    memory.recordToolResult("session-a", "qone_browser_open", { url: "https://www.nodeseek.com/post-1" }, { content: [] });
    memory.recordToolResult("session-a", "qone_browser_extract", {}, { content: [{ type: "text", text: "article" }] });

    const context = memory.context("session-a");
    expect(context).toContain("www.nodeseek.com");
    expect(context).toContain("web_fetch failed (HTTP 403)");
    expect(context).toContain("OpenCLI Browser Bridge succeeded");
    expect(context).toContain("MUST use OpenCLI Browser Bridge");
  });

  test("does not leak access memory between sessions and survives reload", () => {
    const saved = store();
    const first = new WebAccessMemory(saved);
    first.recordToolResult("session-a", "web_fetch", { url: "https://a.example.com" }, { isError: true, content: [{ type: "text", text: "timeout" }] });
    expect(first.context("session-b")).toBe("");

    const second = new WebAccessMemory(saved);
    expect(second.context("session-a")).toContain("a.example.com");
    expect(second.context("session-a")).toContain("web_fetch failed (timeout)");
  });

  test("promotes direct HTTP again when a later fetch succeeds", () => {
    const memory = new WebAccessMemory(store());
    memory.recordToolResult("session-a", "web_fetch", { url: "https://example.com/slow" }, { isError: true, content: [{ type: "text", text: "timeout" }] });
    memory.recordToolResult("session-a", "web_fetch", { url: "https://example.com/fast" }, {
      details: { status: 200, content: "Readable page" },
    });
    const context = memory.context("session-a");
    expect(context).toContain("MUST use web_fetch");
    expect(context).toContain("web_fetch succeeded");
  });

  test("keeps an earlier host route after linked research visits many other hosts", () => {
    const memory = new WebAccessMemory(store());
    memory.recordToolResult("session-a", "web_fetch", { url: "https://a.example.com/post" }, {
      details: { status: 403, content: "blocked" },
    });
    memory.recordToolResult("session-a", "qone_browser_open", { url: "https://a.example.com/post" }, { content: [] });
    memory.recordToolResult("session-a", "qone_browser_extract", {}, { content: [{ type: "text", text: "article" }] });
    for (let index = 0; index < 24; index++) {
      memory.recordToolResult("session-a", "web_fetch", { url: `https://linked-${index}.example.com/page` }, {
        details: { status: 200, content: "linked page" },
      });
    }
    const context = memory.context("session-a");
    expect(context).toContain("a.example.com");
    expect(context).toContain("MUST use OpenCLI Browser Bridge");
  });

  test("puts the current task host first and makes the remembered route mandatory", () => {
    const memory = new WebAccessMemory(store());
    memory.recordToolResult("session-a", "web_fetch", { url: "https://a.example.com/post" }, {
      isError: true, content: [{ type: "text", text: "HTTP 403" }],
    });
    memory.recordToolResult("session-a", "qone_browser_open", { url: "https://a.example.com/post" }, { content: [] });
    memory.recordToolResult("session-a", "qone_browser_extract", {}, { content: [{ type: "text", text: "article" }] });
    memory.recordToolResult("session-a", "web_fetch", { url: "https://b.example.com/post" }, {
      details: { status: 403, content: "blocked" },
    });
    const context = memory.context("session-a", "继续读取 https://a.example.com/post 中的信息");
    expect(context.indexOf("a.example.com")).toBeLessThan(context.indexOf("b.example.com"));
    expect(context).toContain("MUST use OpenCLI Browser Bridge");
    expect(context).toContain("MUST NOT call a known failing route again");
  });

  test("rebuilds routes from persisted tool history when the runtime hook missed a write", () => {
    const memory = new WebAccessMemory(store());
    const context = memory.context("session-a", "继续读取 https://a.example.com/post", [
      {
        toolName: "web_fetch",
        args: { url: "https://a.example.com/post" },
        result: { isError: true, content: [{ type: "text", text: "timeout" }] },
        at: 1,
      },
      {
        toolName: "qone_browser_open",
        args: { url: "https://a.example.com/post" },
        result: { content: [] },
        at: 2,
      },
      {
        toolName: "qone_browser_extract",
        args: {},
        result: { content: [{ type: "text", text: "article" }] },
        at: 3,
      },
    ]);
    expect(context).toContain("a.example.com");
    expect(context).toContain("MUST use OpenCLI Browser Bridge");
    expect(context).toContain("web_fetch failed (timeout)");
  });
});
