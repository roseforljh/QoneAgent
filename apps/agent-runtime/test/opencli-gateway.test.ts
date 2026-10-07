import { describe, expect, test } from "bun:test";
import { openDb, closeDb } from "@qone/database";
import { BrowserSyncService, assertOpenCliRoute, buildOpenCliCommandArgs, compactOpenCliCatalog, loginRequiredResult, normalizeBrowserWaitValue, OpenCliError, parseOpenCliCatalog, runOpenCli } from "../src/browser-sync";

describe("OpenCLI gateway", () => {
  test("site adapters reject Douyin while built-in browser navigation can open it", async () => {
    const db = openDb(":memory:");
    try {
      const service = new BrowserSyncService(() => {}, async () => {});
      expect(() => runOpenCli(["douyin", "search", "creator"])).toThrow();
      expect(() => runOpenCli(["twitter", "search", "qone"])).toThrow("built-in browser target");
      expect(() => assertOpenCliRoute(["example", "get", "--url=https://www.iesdouyin.com/share/video/123"])).toThrow();
      expect(() => assertOpenCliRoute(["twitter", "search", "douyin.com"])).not.toThrow();
      expect(() => assertOpenCliRoute(["browser", "qone", "open", "https://www.douyin.com/user/author"])).toThrow();
      expect(() => assertOpenCliRoute(["browser", "qone", "open", "https://github.com"])).not.toThrow();
    } finally { closeDb(db); }
  });
  test("registers discovery and adapter tools without connecting a browser", async () => {
    const db = openDb(":memory:");
    let toolRefreshes = 0;
    try {
      const service = new BrowserSyncService(() => {}, async () => { toolRefreshes += 1; });
      await service.initialize();
      const tools = service.tools().map((tool) => tool.name);
      expect(tools).toContain("qone_opencli_discover");
      expect(tools).toContain("qone_opencli_run");
      expect(tools).toContain("qone_browser_screenshot");
      const open = service.tools().find((tool) => tool.name === "qone_opencli_run");
      const discover = service.tools().find((tool) => tool.name === "qone_opencli_discover");
      const screenshot = service.tools().find((tool) => tool.name === "qone_browser_screenshot");
      expect(open?.description).toContain("use this route directly");
      expect(discover?.description).toContain("even when the URL is public");
      expect(screenshot?.description).toContain("full page");
      expect(service.tools().find((tool) => tool.name === "qone_browser_extract")?.description).toContain("readable Markdown");
      expect(toolRefreshes).toBe(1);
      expect(service.status().targetConnected).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  test("parses the official command registry and keeps adapter capabilities", () => {
    const commands = parseOpenCliCatalog(JSON.stringify([
      {
        command: "example/search",
        site: "example",
        name: "search",
        description: "Search example",
        access: "read",
        strategy: "public",
        browser: false,
        args: [{ name: "query", type: "string", required: true, positional: true, help: "Keyword" }],
      },
    ]));
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ site: "example", name: "search", strategy: "public", browser: false });
    expect(compactOpenCliCatalog(commands, "example")).toMatchObject({ totalMatches: 1 });
  });

  test("passes adapter arguments through without forcing browser options", () => {
    expect(buildOpenCliCommandArgs({ site: "example", command: "search", args: ["hello", "--limit", "10"] })).toEqual([
      "example", "search", "hello", "--limit", "10", "--format", "json",
    ]);
  });

  test("caps browser time waits so a model cannot block for minutes", () => {
    expect(normalizeBrowserWaitValue("time", "3000")).toBe("60");
    expect(normalizeBrowserWaitValue("selector", "3000")).toBe("3000");
    expect(() => normalizeBrowserWaitValue("time", "forever")).toThrow();
  });

  test("turns OpenCLI auth failures into a structured login result", () => {
    const result = loginRequiredResult(new OpenCliError("Not logged in to example.com", 77), "example");
    expect(result).toBeDefined();
    expect(JSON.parse(result!.content[0].text)).toMatchObject({ status: "login_required", site: "example" });
    expect(loginRequiredResult(new OpenCliError("failed", 1), "example")).toBeUndefined();
  });

  test("rejects shell-like site and command names while allowing raw option values", () => {
    expect(() => buildOpenCliCommandArgs({ site: "example;whoami", command: "search" })).toThrow();
    expect(buildOpenCliCommandArgs({ site: "example", command: "search", args: ["--query", "a;whoami"] })).toContain("a;whoami");
  });

  test("exposes Bilibili discovery and adapter tools", async () => {
    const db = openDb(":memory:");
    try {
      const service = new BrowserSyncService(() => {}, async () => {});
      const discover = service.tools().find((item) => item.name === "qone_opencli_discover")!;
      const run = service.tools().find((item) => item.name === "qone_opencli_run")!;
      expect(discover.description).toContain("built-in browser profile");
      expect(run.description).toContain("There is no external browser fallback");
      expect(service.status().targetConnected).toBe(false);
    } finally { closeDb(db); }
  });
});
