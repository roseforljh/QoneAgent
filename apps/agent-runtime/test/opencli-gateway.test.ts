import { describe, expect, test } from "bun:test";
import { openDb, closeDb } from "@qone/database";
import { BrowserSyncService, assertOpenCliRoute, buildOpenCliCommandArgs, compactOpenCliCatalog, parseOpenCliCatalog, runOpenCli } from "../src/browser-sync";

describe("OpenCLI gateway", () => {
  test("Douyin is rejected before launching Chrome or an OpenCLI process", async () => {
    const db = openDb(":memory:");
    try {
      const service = new BrowserSyncService(db, ":memory:", () => {}, async () => {});
      const tool = service.tools().find((item) => item.name === "qone_browser_open")!;
      await expect(tool.execute("wrong-route", { url: "https://v.douyin.com/share/" }, new AbortController().signal, undefined, undefined as never))
        .rejects.toMatchObject({ code: "browser-sync.douyin_embedded_route_required" });
      expect(service.status().phase).not.toBe("connecting");
      expect(service.status().targetConnected).toBe(false);
      expect(() => runOpenCli(["douyin", "search", "creator"])).toThrow();
      expect(() => assertOpenCliRoute(["browser", "qone", "open", "https://www.douyin.com/user/author"])).toThrow();
      expect(() => assertOpenCliRoute(["example", "get", "--url=https://www.iesdouyin.com/share/video/123"])).toThrow();
      expect(() => assertOpenCliRoute(["twitter", "search", "douyin.com"])).not.toThrow();
      expect(() => assertOpenCliRoute(["browser", "qone", "open", "https://github.com"])).not.toThrow();
    } finally { closeDb(db); }
  });
  test("registers discovery and adapter tools without connecting a browser", async () => {
    const db = openDb(":memory:");
    let toolRefreshes = 0;
    try {
      const service = new BrowserSyncService(db, ":memory:", () => {}, async () => { toolRefreshes += 1; });
      await service.initialize();
      const tools = service.tools().map((tool) => tool.name);
      expect(tools).toContain("qone_opencli_discover");
      expect(tools).toContain("qone_opencli_run");
      expect(tools).toContain("qone_browser_screenshot");
      const open = service.tools().find((tool) => tool.name === "qone_opencli_run");
      const discover = service.tools().find((tool) => tool.name === "qone_opencli_discover");
      const screenshot = service.tools().find((tool) => tool.name === "qone_browser_screenshot");
      expect(open?.description).toContain("use web_fetch first");
      expect(discover?.description).toContain("Do not use this for ordinary public URL reading");
      expect(screenshot?.description).toContain("full page");
      expect(service.tools().find((tool) => tool.name === "qone_browser_extract")?.description).toContain("automatically capture");
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

  test("rejects shell-like site and command names while allowing raw option values", () => {
    expect(() => buildOpenCliCommandArgs({ site: "example;whoami", command: "search" })).toThrow();
    expect(buildOpenCliCommandArgs({ site: "example", command: "search", args: ["--query", "a;whoami"] })).toContain("a;whoami");
  });
});
