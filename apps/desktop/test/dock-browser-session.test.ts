import { expect, test } from "bun:test";
import { clipBrowserBounds, createDockBrowserSession } from "../src/lib/dock-browser-session";

const bounds = { x: 700, y: 80, w: 400, h: 600 };
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

test("unmount during native creation closes the old child before a new mount opens", async () => {
  const opening = deferred();
  const calls: string[] = [];
  let firstOpen = true;
  const invoke = async (command: string) => {
    calls.push(command);
    if (command === "browser_open" && firstOpen) {
      firstOpen = false;
      await opening.promise;
    }
  };
  const first = createDockBrowserSession(invoke, "https://example.com", () => {});
  first.update(bounds, true);
  await tick();
  first.dispose();
  const second = createDockBrowserSession(invoke, "https://example.com", () => {});
  second.update(bounds, true);
  try {
    expect(calls).toEqual(["browser_open"]);
    opening.resolve();
    await tick();
    expect(calls).toEqual(["browser_open", "browser_close", "browser_open", "browser_bounds", "browser_visible"]);
  } finally {
    opening.resolve();
    second.dispose();
    await tick();
  }
});

test("menus hide the native layer and restore its bounds before revealing it", async () => {
  const calls: Array<{ command: string; args?: Record<string, unknown> }> = [];
  const session = createDockBrowserSession(async (command, args) => { calls.push({ command, args }); }, "https://example.com", () => {});
  try {
    session.update(bounds, true);
    await tick();
    calls.length = 0;
    session.update(bounds, false);
    await tick();
    session.update({ ...bounds, x: 600 }, false);
    await tick();
    expect(calls).toEqual([{ command: "browser_visible", args: { visible: false } }]);
    session.update(bounds, true);
    await tick();
    expect(calls.slice(1)).toEqual([
      { command: "browser_bounds", args: bounds },
      { command: "browser_visible", args: { visible: true } },
    ]);
  } finally {
    session.dispose();
    await tick();
  }
});

test("a menu opened while native creation is pending prevents the child from showing", async () => {
  const opening = deferred();
  const calls: string[] = [];
  const session = createDockBrowserSession(async (command) => {
    calls.push(command);
    if (command === "browser_open") await opening.promise;
  }, "https://example.com", () => {});
  try {
    session.update(bounds, true);
    await tick();
    session.update(bounds, false);
    opening.resolve();
    await tick();
    expect(calls).toEqual(["browser_open"]);
  } finally {
    opening.resolve();
    session.dispose();
    await tick();
  }
});

test("failed creation releases the child and does not poison the next session", async () => {
  const errors: unknown[] = [];
  const calls: string[] = [];
  const first = createDockBrowserSession(async (command) => {
    calls.push(command);
    if (command === "browser_open") throw new Error("WebView2 failed");
  }, "https://example.com", (error) => errors.push(error));
  first.update(bounds, true);
  await tick();
  expect(errors).toHaveLength(1);
  expect(calls).toEqual(["browser_open", "browser_close"]);
  first.dispose();
  await tick();
  const second = createDockBrowserSession(async (command) => { calls.push(command); }, "https://example.com", () => {});
  try {
    second.update(bounds, true);
    await tick();
    expect(calls.slice(-3)).toEqual(["browser_open", "browser_bounds", "browser_visible"]);
  } finally {
    second.dispose();
    await tick();
  }
});

test("animation bounds are coalesced while native creation is pending", async () => {
  const opening = deferred();
  const placed: Record<string, unknown>[] = [];
  const session = createDockBrowserSession(async (command, args) => {
    if (command === "browser_open") await opening.promise;
    if (command === "browser_bounds") placed.push(args!);
  }, "https://example.com", () => {});
  try {
    session.update(bounds, true);
    await tick();
    for (let x = 0; x < 100; x++) session.update({ ...bounds, x }, true);
    opening.resolve();
    await tick();
    expect(placed).toEqual([{ ...bounds, x: 99 }]);
  } finally {
    opening.resolve();
    session.dispose();
    await tick();
  }
});

test("native bounds stay inside the viewport during panel transitions", () => {
  expect(clipBrowserBounds({ left: -200, top: 80, right: 216, bottom: 900 }, 1200, 800))
    .toEqual({ x: 0, y: 80, w: 216, h: 720 });
  expect(clipBrowserBounds({ left: 1198, top: 80, right: 1614, bottom: 800 }, 1200, 800)).toBeUndefined();
});

test("an offscreen host hides its old native hit area", async () => {
  const visibility: unknown[] = [];
  const session = createDockBrowserSession(async (command, args) => {
    if (command === "browser_visible") visibility.push(args?.visible);
  }, "https://example.com", () => {});
  try {
    session.update(bounds, true);
    await tick();
    session.update(undefined, true);
    await tick();
    session.update(bounds, true);
    await tick();
    expect(visibility).toEqual([true, false, true]);
  } finally {
    session.dispose();
    await tick();
  }
});

test("WebView2 commands cannot block the synchronous IPC handler", async () => {
  const source = await Bun.file(new URL("../src-tauri/src/main.rs", import.meta.url)).text();
  for (const command of ["open", "navigate", "bounds", "visible", "eval", "close"]) {
    expect(source).toMatch(new RegExp(`async fn browser_${command}\\(`));
  }
  expect(source).toContain("spawn_blocking(move || browser::open");
});
