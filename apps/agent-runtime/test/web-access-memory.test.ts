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
    expect(context).toContain("Prefer OpenCLI Browser Bridge");
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
    expect(context).toContain("Prefer web_fetch");
    expect(context).toContain("web_fetch succeeded");
  });
});
