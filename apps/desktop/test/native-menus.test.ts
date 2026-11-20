import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { clipboardWrites, installElectronMock } from "./helpers/electron-mock";

installElectronMock();
const { contextMenuItems, nativeCopy, updateNativeCopy } = await import("../electron/native-menus");
const { authorizeAttachmentPreview, authorizeFilePreview, isAuthorizedAsset } = await import("../electron/file-dialogs");

const flags = { canUndo: true, canRedo: false, canCut: true, canCopy: true, canPaste: true, canDelete: true, canSelectAll: true, canEditRichly: false };
const base = { isEditable: false, selectionText: "", linkURL: "", mediaType: "none", srcURL: "", x: 3, y: 4, editFlags: flags } as const;
const contents = { copyImageAt: () => {}, downloadURL: () => {} };
const roles = (items: { role?: string; label?: string; type?: string }[]) => items.map((item) => item.role ?? item.type ?? item.label);

test("context menu keeps the WebView2 allow-list: edit commands, copy, link and image actions only", () => {
  expect(contextMenuItems({ ...base }, contents)).toEqual([]);
  expect(roles(contextMenuItems({ ...base, isEditable: true }, contents)))
    .toEqual(["undo", "redo", "separator", "cut", "copy", "paste", "selectAll"]);
  expect(roles(contextMenuItems({ ...base, selectionText: "hi" }, contents))).toEqual(["copy"]);
  const link = contextMenuItems({ ...base, linkURL: "https://example.com/a" }, contents);
  link[0]!.click?.({} as never, undefined, {} as never);
  expect(clipboardWrites.at(-1)).toBe("https://example.com/a");
  expect(roles(contextMenuItems({ ...base, mediaType: "image", srcURL: "https://example.com/i.png", linkURL: "https://example.com" }, contents)))
    .toEqual(["Copy Link", "separator", "Copy Image", "Save Image As…"]);
});

test("native labels follow the renderer language and ignore invalid values", () => {
  updateNativeCopy({ copy: "复制", quit: "", unknown: "x", show: 1 });
  expect(nativeCopy.copy).toBe("复制");
  expect(nativeCopy.quit).toBe("Quit");
  expect(nativeCopy.show).toBe("Show Qone");
  expect(roles(contextMenuItems({ ...base, selectionText: "x" }, contents))).toEqual(["copy"]);
  expect(contextMenuItems({ ...base, selectionText: "x" }, contents)[0]!.label).toBe("复制");
  updateNativeCopy({ copy: "Copy" });
});

test("asset:// only serves authorized previews, and the project root check compares path components", () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-asset-"));
  try {
    mkdirSync(path.join(root, "app"));
    mkdirSync(path.join(root, "app2"));
    const inside = path.join(root, "app", "a.pdf");
    const sibling = path.join(root, "app2", "b.pdf");
    writeFileSync(inside, "x");
    writeFileSync(sibling, "x");
    expect(isAuthorizedAsset(inside)).toBe(false);
    expect(isAuthorizedAsset(authorizeFilePreview(inside, path.join(root, "app")))).toBe(true);
    expect(() => authorizeFilePreview(sibling, path.join(root, "app"))).toThrow("native.filePreviewScope");
    expect(isAuthorizedAsset(sibling)).toBe(false);
    const image = path.join(root, "app", "p.png");
    writeFileSync(image, "x");
    authorizeAttachmentPreview(image);
    expect(isAuthorizedAsset(image.toUpperCase())).toBe(process.platform === "win32");
    expect(() => authorizeAttachmentPreview(path.join(root, "secret.txt"))).toThrow("native.previewPath");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
