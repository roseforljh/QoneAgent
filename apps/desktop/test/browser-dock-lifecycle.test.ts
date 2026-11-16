import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installElectronMock } from "./helpers/electron-mock";

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
  const dock = new BrowserDockManager(() => win as never, 9222);
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
  const dock = new BrowserDockManager(() => win as never, 9222);
  dock.open("b1", "https://first.example", 0, 0, 100, 100);
  const first = [...win.children][0] as View;
  dock.open("b1", "https://second.example", 0, 0, 100, 100);
  expect(first.webContents.isDestroyed()).toBe(true);
  expect(win.children.size).toBe(1);
  dock.closeAll();
  expect(win.children.size).toBe(0);
});

test("closeAll destroys every view", () => {
  const win = windowStub();
  const dock = new BrowserDockManager(() => win as never, 9222);
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
    const dock = new BrowserDockManager(() => windowStub() as never, 9222);
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
