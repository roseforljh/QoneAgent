import { dialog, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";

export interface AttachmentFileInfo {
  name: string;
  path: string;
  size: number;
  isDirectory: boolean;
}

function getAttachmentInfo(targetPath: string): AttachmentFileInfo {
  const stat = fs.statSync(targetPath);
  return {
    name: path.basename(targetPath) || "attachment",
    path: targetPath,
    size: stat.isFile() ? stat.size : 0,
    isDirectory: stat.isDirectory(),
  };
}

export async function pickWorkspace(
  mainWindow: BrowserWindow,
  title: string
): Promise<string | null> {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return result.filePaths[0];
}

export function inspectDroppedFile(targetPath: string): AttachmentFileInfo {
  return getAttachmentInfo(targetPath);
}

export async function pickAttachmentFiles(
  mainWindow: BrowserWindow,
  title: string
): Promise<AttachmentFileInfo[]> {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ["openFile", "multiSelections"],
  });
  if (result.canceled) return [];
  return result.filePaths.map((p) => getAttachmentInfo(p));
}

export async function pickAttachmentFolder(
  mainWindow: BrowserWindow,
  title: string
): Promise<AttachmentFileInfo | null> {
  const result = await dialog.showOpenDialog(mainWindow, {
    title,
    properties: ["openDirectory"],
  });
  if (result.canceled || result.filePaths.length === 0) return null;
  return getAttachmentInfo(result.filePaths[0]);
}

// asset:// serves only files the renderer authorized (Tauri's asset scope). Windows paths are case-insensitive.
const authorizedAssets = new Set<string>();
const assetKey = (filePath: string) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
export function isAuthorizedAsset(filePath: string): boolean {
  return authorizedAssets.has(assetKey(filePath));
}

export function authorizeAttachmentPreview(filePath: string): void {
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, "");
  if (!path.isAbsolute(filePath) || !["png", "jpg", "jpeg", "webp", "gif"].includes(ext)) {
    throw new Error("native.previewPath");
  }
  if (fs.existsSync(filePath) && fs.statSync(filePath).isDirectory()) {
    throw new Error("native.previewFolder");
  }
  authorizedAssets.add(assetKey(filePath));
}

export function authorizeFilePreview(filePath: string, allowedRoot?: string): string {
  if (!path.isAbsolute(filePath)) {
    throw new Error("native.filePreviewPath");
  }
  if (!fs.existsSync(filePath)) {
    authorizedAssets.add(assetKey(filePath));
    return filePath;
  }
  const canonical = fs.realpathSync(filePath);
  const stat = fs.statSync(canonical);
  if (!stat.isFile()) {
    throw new Error("native.filePreviewType");
  }
  if (allowedRoot && fs.existsSync(allowedRoot)) {
    // Compare path components: a plain prefix check let C:\work\app2 pass for root C:\work\app.
    const relative = path.relative(fs.realpathSync(allowedRoot), canonical);
    if (!relative || relative.split(path.sep)[0] === ".." || path.isAbsolute(relative)) {
      throw new Error("native.filePreviewScope");
    }
  }
  authorizedAssets.add(assetKey(canonical));
  return canonical;
}

export async function saveImageAs(
  mainWindow: BrowserWindow,
  filename: string,
  base64Data: string,
  title: string
): Promise<boolean> {
  const result = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: filename || "image.png",
  });
  if (result.canceled || !result.filePath) return false;
  const buffer = Buffer.from(base64Data, "base64");
  if (buffer.length === 0) {
    throw new Error("native.imageEmpty");
  }
  fs.writeFileSync(result.filePath, buffer);
  return true;
}
