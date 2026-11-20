import { describe, expect, test } from "bun:test";
import { openDb, closeDb } from "@qone/database";
import { decodeCommand } from "@qone/protocol";
import { BrowserSyncService, assertOpenCliRoute, buildOpenCliCommandArgs, compactOpenCliCatalog, loginRequiredResult, normalizeBrowserWaitValue, OpenCliError, parseOpenCliCatalog, runOpenCli } from "../src/browser-sync";
import { AppOpenCliBridge, withBrowserSessionId } from "../src/app-opencli-bridge";

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
      expect(open?.description).toContain("built-in browser profile");
      expect(discover?.description).toContain("Pass a site");
      expect(discover?.description).not.toContain("qone_browser_open");
      expect(service.tools().find((tool) => tool.name === "qone_browser_open")?.description).toContain("when direct fetch is unavailable or insufficient");
      expect(screenshot?.description).toContain("full page");
      expect(service.tools().find((tool) => tool.name === "qone_browser_extract")?.description).toContain("readable Markdown");
      // get text 在 OpenCLI 中必须带元素 target，不能作为整页属性暴露
      expect(JSON.stringify(service.tools().find((tool) => tool.name === "qone_browser_get")?.parameters)).not.toContain("\"text\"");
      expect(toolRefreshes).toBe(1);
      expect(service.status().targetConnected).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  test("lists only through the read-only bridge and never supplies a fallback URL for page reads", async () => {
    const requests: Array<{ site: string; url?: string; listTabs?: true; sessionId?: string; reuseRequestId?: string }> = [];
    const bridge = new AppOpenCliBridge((event) => {
      if (event.type !== "apps.opencli.request") throw new Error("Read-only requests must not release a page");
      requests.push(event);
      const response = decodeCommand(JSON.stringify({ type: "apps.opencli.response", requestId: event.requestId,
        ...(event.listTabs ? { ok: true, tabs: [] } : { ok: false, message: "No active page" }),
      }));
      if (response?.type !== "apps.opencli.response") throw new Error("Invalid OpenCLI response");
      bridge.handleResponse(response);
    });
    const service = new BrowserSyncService(() => {}, async () => {}, bridge);
    const execute = (name: string, args = {}) => service.tools().find((item) => item.name === `qone_browser_${name}`)!
      .execute("call", args, undefined, undefined, {} as never);
    await withBrowserSessionId("session-browsing", async () => {
      expect(await execute("tabs")).toMatchObject({ content: [{ text: "[]" }] });
      expect(service.status().targetConnected).toBe(false);
      for (const [name, args] of [["state", {}], ["get", { property: "url" }], ["extract", {}], ["screenshot", {}]] as const) {
        await expect(execute(name, args)).rejects.toThrow("No active page");
      }
      await expect(execute("open", { url: "https://" })).rejects.toThrow("HTTP or HTTPS URL");
      await expect(execute("open", { url: "https://www.spaceship.com/" })).rejects.toThrow("No active page");
    });
    expect(requests.map(({ listTabs, url, sessionId }) => ({ listTabs, url, sessionId }))).toEqual([
      { listTabs: true, url: undefined, sessionId: "session-browsing" },
      ...Array.from({ length: 4 }, () => ({ listTabs: undefined, url: undefined, sessionId: "session-browsing" })),
      { listTabs: undefined, url: "https://www.spaceship.com/", sessionId: "session-browsing" },
    ]);
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

  test("discovery finds the article reader from mixed keywords without returning the entire site catalog", () => {
    const commands = parseOpenCliCatalog(JSON.stringify([
      { command: "twitter/accept", site: "twitter", name: "accept", description: "Auto-accept DM requests", access: "write" },
      { command: "twitter/search", site: "twitter", name: "search", description: "Search Twitter for tweets" },
      { command: "twitter/article", site: "twitter", name: "article", description: "Fetch a Twitter Article and export as Markdown", strategy: "cookie", args: [{ name: "tweet-id", required: true, positional: true }] },
      { command: "other/article", site: "other", name: "article", description: "Read article" },
    ]));
    expect(compactOpenCliCatalog(commands, "twitter", "tweet article read detail status", 1)).toMatchObject({
      totalMatches: 2, commands: [{ site: "twitter", command: "article", strategy: "cookie", args: [{ name: "tweet-id", required: true, positional: true }] }],
    });
    expect(compactOpenCliCatalog(commands, "twitter", "no-match")).toEqual({ totalMatches: 0, commands: [] });
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
    expect(JSON.parse(result!.content[0].text)).toMatchObject({
      status: "login_required", site: "example", scope: "operation", next: expect.stringContaining("follow the direct URL reading policy before asking"),
    });
    expect(loginRequiredResult(new OpenCliError("failed", 1), "example")).toBeUndefined();
  });

  test("rejects shell-like site and command names while allowing raw option values", () => {
    expect(() => buildOpenCliCommandArgs({ site: "example;whoami", command: "search" })).toThrow();
    expect(buildOpenCliCommandArgs({ site: "example", command: "search", args: ["--query", "a;whoami"] })).toContain("a;whoami");
  });

  test("browser release cancels queued work and a late preparation cannot replace the new session", async () => {
    const releases: string[] = [], prepares: string[] = [];
    const callbacks: ((value: { requestId: string; endpoint: string }) => void)[] = [];
    const bridge = { prepare: async () => {
      prepares.push("prepare");
      return new Promise<{ requestId: string; endpoint: string }>(resolve => callbacks.push(resolve));
    }, release: (id: string) => { releases.push(id); } };
    const service = new BrowserSyncService(() => {}, async () => {}, bridge as never);
    const state = service as unknown as { embeddedBrowser?: { requestId: string } };
    const tool = service.tools().find(item => item.name === "qone_browser_state")!;
    const execute = (signal?: AbortSignal) => tool.execute("call", {}, signal, undefined, {} as never);
    const old = execute().catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    const queued = execute().catch(error => error);
    await service.release();
    const controller = new AbortController();
    const next = execute(controller.signal).catch(error => error);
    await new Promise(resolve => setImmediate(resolve));
    expect(prepares).toHaveLength(2);
    controller.abort();
    callbacks[1]!({ requestId: "new", endpoint: "http://new" });
    expect(await next).toBeInstanceOf(Error);
    state.embeddedBrowser = { requestId: "replacement" };
    callbacks[0]!({ requestId: "old", endpoint: "http://old" });
    for (const error of await Promise.all([old, queued])) expect(error).toBeInstanceOf(Error);
    expect(state.embeddedBrowser?.requestId).toBe("replacement");
    expect(releases.sort()).toEqual(["new", "old"]);
    await service.release();
    expect(releases.at(-1)).toBe("replacement");
  });

  test("exposes Bilibili discovery and adapter tools", async () => {
    const db = openDb(":memory:");
    try {
      const service = new BrowserSyncService(() => {}, async () => {});
      const discover = service.tools().find((item) => item.name === "qone_opencli_discover")!;
      const run = service.tools().find((item) => item.name === "qone_opencli_run")!;
      expect(discover.description).toContain("built-in browser profile");
      expect(run.description).toContain("raw adapter arguments");
      expect(service.status().targetConnected).toBe(false);
    } finally { closeDb(db); }
  });

  test("forwards sessionId and reuseRequestId to desktop bridge and closes explicitly on qone_browser_close", async () => {
    const events: Array<{ type: string; requestId: string; sessionId?: string; reuseRequestId?: string; close?: boolean }> = [];
    const bridge = new AppOpenCliBridge((event) => {
      events.push(event);
      if (event.type === "apps.opencli.request") {
        queueMicrotask(() => bridge.handleResponse({
          type: "apps.opencli.response",
          requestId: event.requestId,
          ok: true,
          endpoint: "ws://127.0.0.1:9222/page",
        }));
      }
    });
    const service = new BrowserSyncService(() => {}, async () => {}, bridge);
    const closeTool = service.tools().find((item) => item.name === "qone_browser_close")!;

    await withBrowserSessionId("session-live-1", async () => {
      const first = await bridge.prepare("browser", "https://example.com/");
      expect(first).toBeDefined();
      const second = await bridge.prepare("browser", undefined, undefined, first.requestId);
      expect(second).toBeDefined();
      (service as unknown as { embeddedBrowser?: { requestId: string; sessionId?: string } }).embeddedBrowser = {
        requestId: first.requestId,
        sessionId: "session-live-1",
      };
      await closeTool.execute("call-close", {}, undefined, undefined, {} as never);
    });

    expect(events[0]).toMatchObject({ type: "apps.opencli.request", sessionId: "session-live-1" });
    expect(events[0]?.reuseRequestId).toBeUndefined();
    expect(events[1]).toMatchObject({ type: "apps.opencli.request", sessionId: "session-live-1", reuseRequestId: events[0]!.requestId });
    expect(events[2]).toEqual({ type: "apps.opencli.release", requestId: events[0]!.requestId, close: true });
  });

  test("a passkey sign-in the page started stops the next browser step with login_required instead of waiting", async () => {
    const bridge = new AppOpenCliBridge((event) => {
      if (event.type === "apps.opencli.request") queueMicrotask(() => bridge.handleResponse({
        type: "apps.opencli.response", requestId: event.requestId, ok: true, endpoint: "ws://127.0.0.1:9222/page", url: "https://www.spaceship.com/", loginRequired: "passkey",
      }));
    });
    const service = new BrowserSyncService(() => {}, async () => {}, bridge);
    const state = service.tools().find((item) => item.name === "qone_browser_state")!;
    const output = await state.execute("call-state", {}, undefined, undefined, {} as never) as { content: [{ text: string }] };
    expect(JSON.parse(output.content[0].text)).toMatchObject({ status: "login_required", site: "www.spaceship.com", detail: expect.stringContaining("passkey") });
    // 句柄仍归本轮，用户登录后继续复用同一个页面。
    expect((service as unknown as { embeddedBrowser?: unknown }).embeddedBrowser).toBeDefined();
  });
});
