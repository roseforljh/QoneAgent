import { describe, expect, test } from "bun:test";
import { browserTools, closeBrowser, closeBrowserForTests, createBrowserTools } from "../src/browser-tools.js";

const tool = (name: string) => browserTools.find((item) => item.name === name)!;

describe("browser tool catalog", () => {
  test("exposes the complete semantic browser surface", () => {
    expect(browserTools.map((item) => item.name)).toEqual([
      "browser.open", "browser.navigate", "browser.snapshot", "browser.click",
      "browser.type", "browser.extract", "browser.screenshot", "browser.download", "browser.close",
    ]);
    for (const item of browserTools) expect(item.execute).toBeFunction();
  });

  test("rejects local file URLs", async () => {
    await expect(tool("browser.open").execute("test", { url: "file:///C:/Windows/win.ini" }, undefined as never, undefined as never, undefined as never)).rejects.toThrow("scheme denied");
  });

  test("opens, inspects, fills and extracts a deterministic page", async () => {
    if (process.env.QONE_RUN_BROWSER_E2E !== "1") return;
    try {
      await tool("browser.open").execute("test", { url: "data:text/html,<main><input id='q'><button>Go</button><p id='out'>ready</p></main>"}, undefined as never, undefined as never, undefined as never);
      await tool("browser.type").execute("test", { selector: "#q", text: "hello" }, undefined as never, undefined as never, undefined as never);
      const result = await tool("browser.extract").execute("test", { selector: "main" }, undefined as never, undefined as never, undefined as never);
      expect(JSON.stringify(result)).toContain("ready");
    } finally {
      await closeBrowserForTests();
    }
  });

  test("isolates browser pages between agent sessions", async () => {
    if (process.env.QONE_RUN_BROWSER_E2E !== "1") return;
    const first = createBrowserTools("session-a");
    const second = createBrowserTools("session-b");
    const execute = (tools: typeof first, name: string, params: Record<string, unknown>) =>
      tools.find((item) => item.name === name)!.execute("test", params as never, undefined as never, undefined as never, undefined as never);
    try {
      await execute(first, "browser.open", { url: "data:text/html,<p>first</p>" });
      await execute(second, "browser.open", { url: "data:text/html,<p>second</p>" });
      expect(JSON.stringify(await execute(first, "browser.extract", { selector: "p" }))).toContain("first");
      expect(JSON.stringify(await execute(second, "browser.extract", { selector: "p" }))).toContain("second");
    } finally {
      await Promise.all([closeBrowser("session-a"), closeBrowser("session-b")]);
    }
  });
});
