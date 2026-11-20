import { clipboard, Menu, type ContextMenuParams, type MenuItemConstructorOptions, type WebContents } from "electron";

/** Labels for native surfaces, synced from the renderer's language via set_native_copy. */
export const nativeCopy = {
  show: "Show Qone", quit: "Quit", completed: "Agent run completed",
  undo: "Undo", redo: "Redo", cut: "Cut", copy: "Copy", paste: "Paste", selectAll: "Select All",
  copyLink: "Copy Link", copyImage: "Copy Image", saveImage: "Save Image As…",
};

export function updateNativeCopy(copy: unknown): void {
  if (!copy || typeof copy !== "object") return;
  for (const key of Object.keys(nativeCopy) as (keyof typeof nativeCopy)[]) {
    const value = (copy as Record<string, unknown>)[key];
    if (typeof value === "string" && value) nativeCopy[key] = value;
  }
}

/**
 * Electron installs a default menu whose hidden accelerators include Ctrl+W
 * (close the window, which quits Qone) and Ctrl+M. Keep only the edit and
 * view commands the WebView2 shell also had.
 */
export function installApplicationMenu(): void {
  Menu.setApplicationMenu(Menu.buildFromTemplate([{ role: "editMenu" }, { role: "viewMenu" }]));
}

type MenuParams = Pick<ContextMenuParams, "isEditable" | "selectionText" | "linkURL" | "mediaType" | "srcURL" | "x" | "y" | "editFlags">;

/** Same allow-list as the old WebView2 policy: no reload, inspect, print or open-in-window. */
export function contextMenuItems(params: MenuParams, contents: Pick<WebContents, "copyImageAt" | "downloadURL">): MenuItemConstructorOptions[] {
  const flags = params.editFlags;
  const groups: MenuItemConstructorOptions[][] = [];
  if (params.isEditable) {
    groups.push(
      [{ role: "undo", label: nativeCopy.undo, enabled: flags.canUndo }, { role: "redo", label: nativeCopy.redo, enabled: flags.canRedo }],
      [{ role: "cut", label: nativeCopy.cut, enabled: flags.canCut }, { role: "copy", label: nativeCopy.copy, enabled: flags.canCopy },
        { role: "paste", label: nativeCopy.paste, enabled: flags.canPaste }, { role: "selectAll", label: nativeCopy.selectAll, enabled: flags.canSelectAll }],
    );
  } else if (params.selectionText.trim()) {
    groups.push([{ role: "copy", label: nativeCopy.copy }]);
  }
  if (params.linkURL) groups.push([{ label: nativeCopy.copyLink, click: () => clipboard.writeText(params.linkURL) }]);
  if (params.mediaType === "image" && params.srcURL) {
    groups.push([{ label: nativeCopy.copyImage, click: () => contents.copyImageAt(params.x, params.y) },
      { label: nativeCopy.saveImage, click: () => contents.downloadURL(params.srcURL) }]);
  }
  return groups.flatMap((group, index): MenuItemConstructorOptions[] => index ? [{ type: "separator" }, ...group] : group);
}

/** Electron shows no context menu at all unless the app builds one. */
export function installContextMenu(contents: WebContents): void {
  contents.on("context-menu", (_event, params) => {
    const items = contextMenuItems(params, contents);
    if (items.length) Menu.buildFromTemplate(items).popup();
  });
}
