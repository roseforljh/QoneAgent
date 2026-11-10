import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";

test("the main window installs the shortcut guard and keeps the renderer isolated", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  // `devtools-policy.test.ts` drives the guard itself; here we only assert that
  // main.ts wires it, so the keyboard filter cannot be dropped by an edit.
  expect(main).toContain("installDevtoolsShortcutGuard(win.webContents)");
  // The renderer must never receive Node access.
  expect(main).toContain("contextIsolation: true");
  expect(main).toContain("nodeIntegration: false");
  expect(main).not.toContain("nodeIntegration: true");
});