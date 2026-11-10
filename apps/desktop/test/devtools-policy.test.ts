import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { blocksDevtoolsShortcut, installDevtoolsShortcutGuard, type DevtoolsShortcutInput } from "../electron/devtools-policy";

/** Minimal stand-in for Electron's webContents: records listeners, replays input. */
function fakeWebContents() {
  const listeners: ((event: { preventDefault(): void }, input: DevtoolsShortcutInput) => void)[] = [];
  return {
    listeners,
    on(_event: "before-input-event", listener: (event: { preventDefault(): void }, input: DevtoolsShortcutInput) => void) {
      listeners.push(listener);
    },
    /** Returns true when the app swallowed the key. */
    press(input: DevtoolsShortcutInput): boolean {
      let prevented = false;
      const event = { preventDefault: () => { prevented = true; } };
      for (const listener of listeners) listener(event, input);
      return prevented;
    },
  };
}

test("F12 and the inspector chords are blocked before the renderer sees them", () => {
  for (const input of [
    { key: "F12" }, { code: "F12", control: true }, { key: "F12", shift: true },
    { code: "KeyI", control: true, shift: true },
    { code: "KeyI", meta: true, alt: true },
    { code: "KeyI", key: "ı", control: true, shift: true },
  ]) {
    expect(blocksDevtoolsShortcut(input), JSON.stringify(input)).toBe(true);
  }
});

test("copy, paste, undo, search and plain typing still reach the page", () => {
  for (const input of [
    { code: "KeyC", control: true }, { code: "KeyV", control: true, shift: true },
    { code: "KeyZ", control: true }, { code: "KeyA", control: true }, { code: "KeyK", control: true },
    { code: "KeyI", key: "i" }, { code: "KeyI", control: true },
    { key: "Enter" }, { key: "Escape" },
  ]) {
    expect(blocksDevtoolsShortcut(input), JSON.stringify(input)).toBe(false);
  }
});

test("the guard wired into a window swallows the chord end to end", () => {
  const win = fakeWebContents();
  installDevtoolsShortcutGuard(win);
  expect(win.listeners).toHaveLength(1);

  expect(win.press({ code: "KeyI", key: "I", control: true, shift: true })).toBe(true);
  expect(win.press({ key: "F12" })).toBe(true);
  expect(win.press({ code: "KeyI", key: "I", meta: true, alt: true })).toBe(true);

  // Normal editing keys must fall through untouched.
  expect(win.press({ code: "KeyC", key: "c", control: true })).toBe(false);
  expect(win.press({ code: "KeyV", key: "v", control: true })).toBe(false);
  expect(win.press({ code: "KeyI", key: "i" })).toBe(false);
  expect(win.press({ key: "Enter" })).toBe(false);
});

test("the main window registers the guard and keeps the renderer isolated", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  // Whoever edits main.ts must keep calling the shared guard, not re-inline it.
  expect(main).toContain("installDevtoolsShortcutGuard(win.webContents)");
  expect(main).toContain("contextIsolation: true");
  expect(main).toContain("nodeIntegration: false");
  expect(main).not.toContain("nodeIntegration: true");
});