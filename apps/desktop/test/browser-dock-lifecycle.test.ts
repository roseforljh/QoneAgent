import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installElectronMock, permissionHandlers } from "./helpers/electron-mock";

installElectronMock();

const { BrowserDockManager } = await import("../electron/browser-dock-manager");

type View = { closed: boolean; webContents: { isDestroyed(): boolean } };

function windowStub() {
  const children = new Set<unknown>();
  return {
    children,
    isDestroyed: () => false,
    contentView: {
      addChildView: (view: unknown) => { children.add(view); },
      removeChildView: (view: unknown) => { children.delete(view); },
    },
    webContents: { send: () => {} },
  };
}

test("closing a dock browser destroys its WebContentsView instead of only detaching it", () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  dock.open("b1", "https://example.com", 0, 0, 100, 100);
  const view = [...win.children][0] as View;
  expect(view.webContents.isDestroyed()).toBe(false);

  dock.close("b1");
  expect(win.children.size).toBe(0);
  // Detaching alone left a renderer process alive per open/close cycle.
  expect(view.webContents.isDestroyed()).toBe(true);
});

test("reopening the same dock id destroys the previous view and keeps one child", () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  dock.open("b1", "https://first.example", 0, 0, 100, 100);
  const first = [...win.children][0] as View;
  dock.open("b1", "https://second.example", 0, 0, 100, 100);
  expect(first.webContents.isDestroyed()).toBe(true);
  expect(win.children.size).toBe(1);
  dock.closeAll();
  expect(win.children.size).toBe(0);
});

test("administrator mode still opens views but never exposes their debugging endpoint", async () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, null);
  dock.open("admin", "https://example.com", 0, 0, 10, 10);
  expect(win.children.size).toBe(1);
  await expect(dock.getCdpEndpoint("admin")).rejects.toThrow("remote debugging is disabled");
  dock.closeAll();
});

test("closeAll destroys every view", () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  for (const id of ["a", "b", "c"]) dock.open(id, "https://example.com", 0, 0, 10, 10);
  const views = [...win.children] as View[];
  expect(views).toHaveLength(3);
  dock.closeAll();
  expect(views.every((view) => view.webContents.isDestroyed())).toBe(true);
  expect(win.children.size).toBe(0);
});

test("external previews are written under Qone's runtime dir and removed on closeAll", () => {
  const dataDir = mkdtempSync(path.join(os.tmpdir(), "qone-preview-"));
  const previous = process.env.QONE_DATA_DIR;
  process.env.QONE_DATA_DIR = dataDir;
  try {
    const dock = new BrowserDockManager(() => windowStub() as never, async () => 9222);
    dock.openPreviewExternal("<h1>preview</h1>");
    const directory = path.join(dataDir, "runtime", "previews");
    const files = existsSync(directory) ? require("node:fs").readdirSync(directory) as string[] : [];
    expect(files).toHaveLength(1);
    expect(readFileSync(path.join(directory, files[0]!), "utf8")).toBe("<h1>preview</h1>");
    dock.closeAll();
    expect(require("node:fs").readdirSync(directory)).toEqual([]);
  } finally {
    if (previous === undefined) delete process.env.QONE_DATA_DIR;
    else process.env.QONE_DATA_DIR = previous;
    rmSync(dataDir, { recursive: true, force: true });
  }
});

type FitView = View & {
  zoom: number;
  pageOverflow: unknown;
  listeners: Map<string, (...args: unknown[]) => void>;
  webContents: { isDestroyed(): boolean };
};
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a page wider than the dock is scaled to fit and returns to 100% once the dock is wide enough", async () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  dock.open("fit", "https://www.douyin.com", 0, 0, 600, 800);
  const view = [...win.children][0] as FitView;
  view.pageOverflow = 1200;
  view.listeners.get("did-finish-load")?.();
  await settle();
  expect(view.zoom).toBe(0.5);

  dock.bounds("fit", 0, 0, 900, 800);
  await settle();
  expect(view.zoom).toBe(0.75);

  dock.bounds("fit", 0, 0, 1400, 800);
  await settle();
  expect(view.zoom).toBe(1);

  // A new document is measured from scratch; a responsive page stays at 100%.
  view.pageOverflow = 0;
  dock.bounds("fit", 0, 0, 600, 800);
  view.listeners.get("did-navigate")?.({}, "https://www.baidu.com");
  await settle();
  expect(view.zoom).toBe(1);
  dock.closeAll();
});

test("dock pages cannot launch external protocol handlers, other pages keep the default grant", () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  const before = permissionHandlers.length;
  dock.open("guard", "https://www.douyin.com", 0, 0, 100, 100);
  const view = [...win.children][0] as View & { webContents: unknown };
  const handler = permissionHandlers[before] as (contents: unknown, permission: string, callback: (granted: boolean) => void) => void;
  const decide = (contents: unknown, permission: string) => { let granted: boolean | undefined; handler(contents, permission, (value) => { granted = value; }); return granted; };
  expect(decide(view.webContents, "openExternal")).toBe(false);
  expect(decide(view.webContents, "notifications")).toBe(true);
  expect(decide({}, "openExternal")).toBe(true);
  dock.closeAll();
});

test("page bridges get their init script before the page loads and a JSON-encoded eval result", async () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  await dock.open("bridge", "https://www.douyin.com/video/1", 0, 0, 10, 10, "window.__probe = 1");
  const view = [...win.children][0] as FitView & { calls: unknown[][] };
  // dom-ready injection ran after page scripts had already sent their API requests.
  expect(view.calls.map((call) => call[0])).toEqual(["Page.enable", "Page.addScriptToEvaluateOnNewDocument", "loadURL"]);
  expect(view.calls[1]![1]).toEqual({ source: "window.__probe = 1" });
  // Bridge probes return JSON strings; callers parse twice, as with WebView2 ExecuteScript.
  view.pageOverflow = '{"videoUrl":"https://v.example/a.mp4"}';
  const raw = await dock.evalResult("bridge", "probe");
  expect(JSON.parse(JSON.parse(raw))).toEqual({ videoUrl: "https://v.example/a.mp4" });
  view.pageOverflow = undefined;
  expect(await dock.evalResult("bridge", "probe")).toBe("null");
  dock.closeAll();
});

test("a page that never finishes loading reads as not-ready instead of hanging the caller", async () => {
  const { jest } = await import("bun:test");
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  await dock.open("slow", "https://www.douyin.com/video/1", 0, 0, 10, 10);
  const view = [...win.children][0] as FitView;
  view.pageOverflow = new Promise(() => {});
  jest.useFakeTimers();
  try {
    const pending = dock.evalResult("slow", "probe");
    jest.advanceTimersByTime(10_000);
    expect(await pending).toBe("null");
  } finally {
    jest.useRealTimers();
    dock.closeAll();
  }
});

test("a browser the user cannot see stays silent and gets its sound back when shown", async () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  // Background bridge pages open offscreen and must never be audible.
  void dock.open("bg", "https://www.douyin.com/video/1", -32000, -32000, 1280, 720);
  const background = [...win.children][0] as FitView & { muted: boolean };
  expect(background.muted).toBe(true);
  void dock.open("tab", "https://www.douyin.com", 0, 0, 600, 800);
  const tab = [...win.children][1] as FitView & { muted: boolean };
  expect(tab.muted).toBe(false);
  // Switching conversations parks the AI's browser offscreen; it keeps playing but must not be heard.
  await dock.bounds("tab", -32000, -32000, 1280, 720);
  expect(tab.muted).toBe(true);
  await dock.bounds("tab", 0, 0, 600, 800);
  expect(tab.muted).toBe(false);
  await dock.setVisible("tab", false);
  expect(tab.muted).toBe(true);
  await dock.setVisible("tab", true);
  expect(tab.muted).toBe(false);
  dock.closeAll();
});

test("dialogs sink dock views below a transparent UI and lift them back on close", () => {
  const children: unknown[] = [];
  const hub = { id: "hub" };
  children.push(hub);
  const transparency: boolean[] = [];
  const win = {
    isDestroyed: () => false,
    setHubTransparent: (on: boolean) => transparency.push(on),
    contentView: {
      children,
      addChildView: (view: unknown, index?: number) => {
        const at = children.indexOf(view);
        if (at >= 0) children.splice(at, 1);
        children.splice(index ?? children.length, 0, view);
      },
      removeChildView: (view: unknown) => { const at = children.indexOf(view); if (at >= 0) children.splice(at, 1); },
    },
    webContents: { send: () => {} },
  };
  const dock = new BrowserDockManager(() => win as never, async () => 9222);
  void dock.open("tab", "https://example.com", 0, 0, 600, 800);
  const tab = children[1];
  expect(children).toEqual([hub, tab]);
  dock.setUnderlay(true);
  expect(children).toEqual([tab, hub]);
  // A view opened while a dialog is up starts below the UI too.
  void dock.open("late", "https://example.com", 0, 0, 600, 800);
  expect(children.indexOf(hub)).toBe(2);
  dock.setUnderlay(false);
  expect(children[0]).toBe(hub);
  expect(transparency).toEqual([true, false]);
  dock.closeAll();
});