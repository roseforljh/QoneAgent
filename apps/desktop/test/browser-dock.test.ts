import { expect, test } from "bun:test";
import {
  externalBrowserUrl,
  htmlFromDataUrl,
  isHtmlDataUrl,
  openBrowserInDock,
  openCodePreviewInDock,
  onOpenBrowserInDock,
  type BrowserDockRequest,
} from "../src/lib/browser-dock";

test("external browser accepts only navigable web pages", () => {
  expect(externalBrowserUrl("https://cn.bing.com/search?q=test")).toBe("https://cn.bing.com/search?q=test");
  expect(externalBrowserUrl("http://localhost:1480/")).toBe("http://localhost:1480/");
  for (const url of ["about:blank", "data:text/html,hello", "file:///C:/test.html", "javascript:alert(1)", "not a URL"]) {
    expect(externalBrowserUrl(url)).toBeUndefined();
  }
});

test("HTML data previews can be opened externally", () => {
  expect(isHtmlDataUrl("data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=")).toBe(true);
  expect(isHtmlDataUrl("data:text/html,%3Ch1%3EHello%3C%2Fh1%3E")).toBe(true);
  expect(isHtmlDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBe(false);
  expect(htmlFromDataUrl("data:text/html;charset=utf-8;base64,PGgxPkhlbGxvPC9oMT4=")).toBe("<h1>Hello</h1>");
  expect(htmlFromDataUrl("data:text/html,%3Ch1%3EHello%3C%2Fh1%3E")).toBe("<h1>Hello</h1>");
  expect(htmlFromDataUrl("data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=")).toBeUndefined();
});

test("openBrowserInDock and openCodePreviewInDock support optional sessionId routing", () => {
  const events: BrowserDockRequest[] = [];
  const listeners: Record<string, ((event: unknown) => void)[]> = {};
  const mockWindow = {
    dispatchEvent: (event: { detail: BrowserDockRequest }) => {
      events.push(event.detail);
      for (const listener of listeners["qone:open-browser"] ?? []) {
        listener(event);
      }
      return true;
    },
    addEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] ??= [];
      listeners[type].push(listener);
    },
    removeEventListener: (type: string, listener: (event: unknown) => void) => {
      listeners[type] = (listeners[type] ?? []).filter((l) => l !== listener);
    },
  };
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: unknown }).window = mockWindow;

  try {
    const received: BrowserDockRequest[] = [];
    const unsubscribe = onOpenBrowserInDock((req) => received.push(req));

    openBrowserInDock("https://example.com");
    expect(events[0]).toEqual({ url: "https://example.com" });

    openBrowserInDock("https://example.com/chat", "session-thread-1");
    expect(events[1]).toEqual({ url: "https://example.com/chat", sessionId: "session-thread-1" });

    openCodePreviewInDock("<p>Demo</p>", "source-preview-1");
    expect(events[2].requestId).toBe("source-preview-1");
    expect(events[2].sessionId).toBeUndefined();

    openCodePreviewInDock("<p>Demo 2</p>", "source-preview-2", "session-thread-2");
    expect(events[3].requestId).toBe("source-preview-2");
    expect(events[3].sessionId).toBe("session-thread-2");

    expect(received).toHaveLength(4);
    expect(received[1]?.sessionId).toBe("session-thread-1");
    expect(received[3]?.sessionId).toBe("session-thread-2");

    unsubscribe();
  } finally {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  }
});

test("an AI page for a conversation that is not open lands in that conversation's saved dock, not offscreen with no tab", async () => {
  const { openAgentBrowserInDock } = await import("../src/lib/browser-dock");
  const { dockScopeKey, useDockState } = await import("../src/lib/dock-state");
  const listeners: ((event: unknown) => void)[] = [];
  const originalWindow = (globalThis as unknown as { window?: unknown }).window;
  (globalThis as unknown as { window: unknown }).window = {
    dispatchEvent: (event: unknown) => { for (const listener of listeners) listener(event); return true; },
    addEventListener: (_type: string, listener: (event: unknown) => void) => { listeners.push(listener); },
    removeEventListener: () => {},
  };
  try {
    // Nobody listening for session-away: its dock is not mounted.
    openAgentBrowserInDock({ browserId: "opencli-browser-1", url: "https://www.douyin.com/video/1", sessionId: "session-away" });
    const away = useDockState.getState().scopes[dockScopeKey("session-away")]!;
    expect(away.openTabs).toHaveLength(1);
    expect(away.openTabs[0]).toMatchObject({ view: "browser", browserTarget: { browserId: "opencli-browser-1", agentManaged: true, sessionId: "session-away" } });
    expect(away.activeTabId).toBe(away.openTabs[0]!.id);
    expect(away.collapsed).toBe(false);
    // A later page in the same conversation reuses that tab.
    openAgentBrowserInDock({ browserId: "opencli-browser-2", url: "https://www.douyin.com/", sessionId: "session-away" });
    const reused = useDockState.getState().scopes[dockScopeKey("session-away")]!;
    expect(reused.openTabs).toHaveLength(1);
    expect(reused.openTabs[0]!.browserTarget?.browserId).toBe("opencli-browser-2");
    // A mounted dock claims the page itself; nothing is written behind its back.
    const unsubscribe = onOpenBrowserInDock((request) => request.onClaimed?.());
    openAgentBrowserInDock({ browserId: "opencli-browser-3", url: "https://example.com", sessionId: "session-open" });
    unsubscribe();
    expect(useDockState.getState().scopes[dockScopeKey("session-open")]).toBeUndefined();
  } finally {
    (globalThis as unknown as { window: unknown }).window = originalWindow;
  }
});
