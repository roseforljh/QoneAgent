import { expect, test } from "bun:test";
import { onCloseAgentBrowserInDock, onOpenBrowserInDock, type BrowserDockRequest } from "../src/lib/browser-dock";
import {
  appOpenCliRequests,
  attachManagedBrowserHost,
  isManagedBrowserBusy,
  isManagedBrowserOpen,
  notifyManagedBrowserClosed,
  releaseAppOpenCliRequest,
  serveAppOpenCliRequest,
  updateManagedBrowserUrl,
} from "../src/store/app-bridge";

function installMockWindow() {
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const mockWindow = {
    dispatchEvent: (event: { type: string; detail: unknown }) => {
      for (const listener of listeners[event.type] ?? []) listener(event);
      return true;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] ??= [];
      listeners[type].push(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((item) => item !== listener);
    },
  };
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: unknown }).window = mockWindow;
  return () => {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  };
}

test("tab lists are read-only; page operations reuse live views and only explicit opens create them", async () => {
  const restoreWindow = installMockWindow();
  const opened: BrowserDockRequest[] = [];
  const closedInDock: string[] = [];
  const liveViews = new Set<string>();
  const invokeCalls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const responses: Array<Record<string, unknown>> = [];

  const invoke = async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
    invokeCalls.push({ command, args });
    const browserId = String(args?.browserId ?? "");
    if (command === "browser_open") liveViews.add(browserId);
    if (command === "browser_close") liveViews.delete(browserId);
    if (command === "opencli_cdp_endpoint") {
      if (!liveViews.has(browserId)) throw new Error("browser session not found");
      return `ws://127.0.0.1:9999/${browserId}` as T;
    }
    return undefined as T;
  };
  const send = async (command: Record<string, unknown>) => {
    responses.push(command);
    return true;
  };

  const offOpen = onOpenBrowserInDock((req) => {
    opened.push(req);
    req.onClaimed?.();
  });
  const offClose = onCloseAgentBrowserInDock((browserId) => closedInDock.push(browserId));

  const listTabs = async (sessionId: string) => {
    const callCount = invokeCalls.length;
    const openedCount = opened.length;
    const requestCount = appOpenCliRequests.size;
    await serveAppOpenCliRequest({
      type: "apps.opencli.request", requestId: "list", site: "browser", sessionId, listTabs: true,
    }, send, invoke);
    expect(invokeCalls).toHaveLength(callCount);
    expect(opened).toHaveLength(openedCount);
    expect(appOpenCliRequests.size).toBe(requestCount);
    expect(responses.at(-1)).toMatchObject({ requestId: "list", ok: true });
    return responses.pop()!.tabs;
  };

  try {
    expect(await listTabs("session-a")).toEqual([]);
    await serveAppOpenCliRequest({
      type: "apps.opencli.request", requestId: "no-page", site: "browser", sessionId: "session-a",
    }, send, invoke);
    expect(responses.pop()).toMatchObject({ ok: false, message: expect.stringContaining("No active") });
    expect(invokeCalls).toHaveLength(0);
    expect(opened).toHaveLength(0);

    // 1. 显式打开内置浏览器并弹出右侧面板
    await serveAppOpenCliRequest({
      type: "apps.opencli.request",
      requestId: "req-1",
      site: "browser",
      url: "https://www.spaceship.com/launchpad/",
      sessionId: "session-a",
    }, send as never, invoke);

    expect(opened).toHaveLength(1);
    const browserId = opened[0]!.browserId!;
    expect(opened[0]!.agentManaged).toBe(true);
    expect(opened[0]!.sessionId).toBe("session-a");
    expect(isManagedBrowserOpen(browserId)).toBe(true);
    expect(isManagedBrowserBusy(browserId)).toBe(true);
    expect(responses[0]).toEqual({
      type: "apps.opencli.response",
      requestId: "req-1",
      ok: true,
      endpoint: `ws://127.0.0.1:9999/${browserId}`,
      url: "https://www.spaceship.com/launchpad/",
    });

    const detach = attachManagedBrowserHost(browserId);
    updateManagedBrowserUrl(browserId, "https://www.spaceship.com/login/");
    expect(await listTabs("session-a")).toEqual([{ id: browserId, url: "https://www.spaceship.com/login/" }]);
    expect(await listTabs("session-other")).toEqual([]);

    // 2. 同一轮后续操作复用同一原生视图，并再次触发右侧面板弹出
    await serveAppOpenCliRequest({
      type: "apps.opencli.request",
      requestId: "req-2",
      reuseRequestId: "req-1",
      site: "browser",
      sessionId: "session-a",
    }, send as never, invoke);

    expect(invokeCalls.filter((call) => call.command === "browser_open")).toHaveLength(1);
    expect(opened).toHaveLength(2);
    expect(opened[1]!.browserId).toBe(browserId);
    expect(opened[1]!.url).toBe("https://www.spaceship.com/login/");

    // 3. 回合结束释放句柄：右侧面板承载时保留页面供用户查看交互
    releaseAppOpenCliRequest("req-1", false, invoke);
    expect(liveViews.has(browserId)).toBe(true);
    expect(isManagedBrowserBusy(browserId)).toBe(false);

    // 4. 下一轮再次操作同一会话时继续复用已打开的右侧内置浏览器
    await serveAppOpenCliRequest({
      type: "apps.opencli.request",
      requestId: "req-3",
      site: "browser",
      sessionId: "session-a",
    }, send as never, invoke);
    expect(invokeCalls.filter((call) => call.command === "browser_open")).toHaveLength(1);
    expect(opened[2]!.browserId).toBe(browserId);

    // 5. 并发请求在主视图忙碌时开辟独立视图，避免 DockCdp 冲突
    await serveAppOpenCliRequest({
      type: "apps.opencli.request",
      requestId: "req-concurrent",
      site: "twitter",
      url: "https://x.com/home",
      sessionId: "session-a",
    }, send as never, invoke);
    expect(invokeCalls.filter((call) => call.command === "browser_open")).toHaveLength(2);
    const concurrentId = opened[3]!.browserId!;
    expect(concurrentId).not.toBe(browserId);
    releaseAppOpenCliRequest("req-concurrent", true, invoke);
    expect(closedInDock).toContain(concurrentId);
    expect(liveViews.has(concurrentId)).toBe(false);

    // 6. 手动关页后，列表为空，旧句柄不能重建；显式打开才创建新页。
    notifyManagedBrowserClosed(browserId);
    liveViews.delete(browserId);
    detach();
    expect(await listTabs("session-a")).toEqual([]);
    await serveAppOpenCliRequest({
      type: "apps.opencli.request", requestId: "stale", site: "browser", sessionId: "session-a", reuseRequestId: "req-3",
    }, send, invoke);
    expect(responses.pop()).toMatchObject({ ok: false, message: expect.stringContaining("No active") });
    expect(invokeCalls.filter((call) => call.command === "browser_open")).toHaveLength(2);
    expect(opened).toHaveLength(4);
    await serveAppOpenCliRequest({
      type: "apps.opencli.request",
      requestId: "req-4",
      reuseRequestId: "req-3",
      site: "browser",
      url: "https://example.com/",
      sessionId: "session-a",
    }, send as never, invoke);
    const rebuiltId = opened[4]!.browserId!;
    expect(rebuiltId).not.toBe(browserId);
    expect(liveViews.has(rebuiltId)).toBe(true);

    // 7. 显式 close 释放时销毁原生视图并通知关闭右侧标签页
    releaseAppOpenCliRequest("req-3", true, invoke);
    expect(liveViews.has(rebuiltId)).toBe(false);
    expect(closedInDock).toContain(rebuiltId);
  } finally {
    offOpen();
    offClose();
    restoreWindow();
  }
});

test("unhosted agent browser closes immediately on release to avoid leaking hidden views", async () => {
  const restoreWindow = installMockWindow();
  const liveViews = new Set<string>();
  const invoke = async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const browserId = String(args?.browserId ?? "");
    if (command === "browser_open") liveViews.add(browserId);
    if (command === "browser_close") liveViews.delete(browserId);
    if (command === "opencli_cdp_endpoint") return `ws://127.0.0.1:9999/${browserId}` as T;
    return undefined as T;
  };
  try {
    await serveAppOpenCliRequest({
      type: "apps.opencli.request",
      requestId: "req-headless",
      site: "browser",
      url: "https://example.com/",
      sessionId: "session-headless",
    }, async () => true, invoke);
    expect(liveViews.size).toBe(1);
    releaseAppOpenCliRequest("req-headless", false, invoke);
    expect(liveViews.size).toBe(0);
  } finally {
    restoreWindow();
  }
});

test("a passkey request the AI triggered mid-turn is reported once; one the user made between turns is not", async () => {
  const restoreWindow = installMockWindow();
  const passkeyViews = new Set<string>();
  const responses: Array<Record<string, unknown>> = [];
  const invoke = async <T = unknown>(command: string, args?: Record<string, unknown>): Promise<T> => {
    const browserId = String(args?.browserId ?? "");
    if (command === "opencli_cdp_endpoint") return `ws://127.0.0.1:9999/${browserId}` as T;
    if (command === "browser_take_passkey_request") return passkeyViews.delete(browserId) as T;
    return undefined as T;
  };
  const send = async (command: Record<string, unknown>) => { responses.push(command); return true; };
  const offOpen = onOpenBrowserInDock((req) => req.onClaimed?.());
  const request = (requestId: string, reuseRequestId?: string) => serveAppOpenCliRequest({
    type: "apps.opencli.request", requestId, site: "browser", url: "https://www.spaceship.com/login/", sessionId: "session-passkey",
    ...(reuseRequestId ? { reuseRequestId } : {}),
  }, send as never, invoke);
  try {
    await request("p-1");
    const browserId = String(responses[0]!.endpoint).split("/").pop()!;
    attachManagedBrowserHost(browserId);
    // AI 点了「用通行密钥登录」，下一步操作立刻得到需要登录。
    passkeyViews.add(browserId);
    await request("p-2", "p-1");
    expect(responses[1]).toMatchObject({ requestId: "p-2", ok: true, loginRequired: "passkey" });
    await request("p-3", "p-1");
    expect(responses[2]!.loginRequired).toBeUndefined();
    releaseAppOpenCliRequest("p-1", false, invoke);
    // 用户两轮之间在右侧栏自己点了通行密钥：新一轮只清掉标记，不误报。
    passkeyViews.add(browserId);
    await request("p-4");
    expect(responses[3]!.loginRequired).toBeUndefined();
    expect(passkeyViews.has(browserId)).toBe(false);
  } finally {
    offOpen();
    restoreWindow();
  }
});
