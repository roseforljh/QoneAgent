import { describe, expect, test } from "bun:test";
import { openDb, closeDb } from "@qone/database";
import { BrowserSyncService, buildOpenCliCommandArgs, compactOpenCliCatalog, parseOpenCliCatalog } from "../src/browser-sync";

describe("OpenCLI gateway", () => {
  test("registers discovery and adapter tools without connecting a browser", async () => {
    const db = openDb(":memory:");
    let toolRefreshes = 0;
    try {
      const service = new BrowserSyncService(db, ":memory:", () => {}, async () => { toolRefreshes += 1; });
      await service.initialize();
      const tools = service.tools().map((tool) => tool.name);
      expect(tools).toContain("qone_opencli_discover");
      expect(tools).toContain("qone_opencli_run");
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
