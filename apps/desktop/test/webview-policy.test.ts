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
test("the main window only shows Qone's UI and has the native menus the WebView2 shell had", () => {
  const main = readFileSync(new URL("../electron/main.ts", import.meta.url), "utf8");
  // An external page loaded here would receive the full desktop bridge from the preload.
  expect(main).toContain(`win.webContents.on("will-navigate"`);
  expect(main).toContain("installContextMenu(win.webContents)");
  // Electron's default menu maps Ctrl+W to closing the window, which quits Qone.
  expect(main).toContain("installApplicationMenu()");
  expect(main).toContain("isAuthorizedAsset(filePath)");
});
