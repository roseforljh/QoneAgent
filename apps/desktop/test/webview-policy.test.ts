import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { runInNewContext } from "node:vm";

const script = readFileSync(new URL("../src-tauri/src/webview-policy.js", import.meta.url), "utf8");

function policy() {
  const listeners: { type: string; callback: (event: any) => void; capture: boolean }[] = [];
  const window = {
    addEventListener(type: string, callback: (event: any) => void, capture = false) {
      listeners.push({ type, callback, capture });
    },
  };
  runInNewContext(script, { window });
  return {
    window,
    dispatch(type: string, keys: Partial<KeyboardEvent> = {}) {
      const event = {
        key: "", code: "", ctrlKey: false, metaKey: false, altKey: false, shiftKey: false,
        ...keys, defaultPrevented: false, stopped: false,
        preventDefault() { this.defaultPrevented = true; },
        stopImmediatePropagation() { this.stopped = true; },
      };
      for (const listener of listeners.filter((listener) => listener.type === type).sort((a, b) => Number(b.capture) - Number(a.capture))) {
        listener.callback(event);
        if (event.stopped) break;
      }
      return event;
    },
  };
}

test("F12 and Tauri inspector shortcuts never reach the debug toggle or editor", () => {
  const view = policy();
  let pageKeys = 0;
  view.window.addEventListener("keydown", () => pageKeys++);
  for (const keys of [
    { key: "F12" }, { code: "F12", ctrlKey: true }, { key: "F12", shiftKey: true },
    { code: "KeyI", ctrlKey: true, shiftKey: true },
    { code: "KeyI", key: "ı", ctrlKey: true, shiftKey: true },
    { code: "KeyI", metaKey: true, altKey: true },
  ]) {
    const event = view.dispatch("keydown", keys);
    expect(event.defaultPrevented).toBe(true);
    expect(event.stopped).toBe(true);
  }
  expect(pageKeys).toBe(0);
});

test("clipboard, terminal copy, input and application shortcuts still propagate", () => {
  const view = policy();
  let pageKeys = 0;
  view.window.addEventListener("keydown", () => pageKeys++);
  const shortcuts = [
    { code: "KeyC", ctrlKey: true }, { code: "KeyC", ctrlKey: true, shiftKey: true },
    { code: "KeyV", ctrlKey: true }, { code: "KeyV", ctrlKey: true, shiftKey: true },
    { code: "KeyX", metaKey: true }, { code: "KeyZ", ctrlKey: true },
    { code: "KeyA", ctrlKey: true }, { code: "KeyK", ctrlKey: true },
    { code: "KeyI", key: "i" }, { code: "KeyI", ctrlKey: true },
    { key: "Process", isComposing: true }, { key: "Enter" }, { key: "Escape" },
  ];
  for (const keys of shortcuts) {
    const event = view.dispatch("keydown", keys);
    expect(event.defaultPrevented).toBe(false);
    expect(event.stopped).toBe(false);
  }
  expect(pageKeys).toBe(shortcuts.length);
});

test("component context menus remain responsible for their own right-clicks", () => {
  const view = policy();
  let menus = 0;
  view.window.addEventListener("contextmenu", () => menus++);
  const event = view.dispatch("contextmenu");
  expect(menus).toBe(1);
  expect(event.defaultPrevented).toBe(false);
  expect(event.stopped).toBe(false);
});

test("main WebView disables DevTools and ACL denies the inherited toggle permission", () => {
  const config = JSON.parse(readFileSync(new URL("../src-tauri/tauri.conf.json", import.meta.url), "utf8"));
  const capability = JSON.parse(readFileSync(new URL("../src-tauri/capabilities/default.json", import.meta.url), "utf8"));
  expect(config.app.windows.every((window: { devtools: boolean }) => window.devtools === false)).toBe(true);
  expect(capability.permissions).toContain("core:webview:deny-internal-toggle-devtools");
});
