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

// asset:// 仅允许访问渲染进程已授权的文件，Windows 路径不区分大小写。
const authorizedAssets = new Set<string>();
const assetKey = (filePath: string) => {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
};
// 预览的 HTML 页面要加载同目录及子目录里的 css/js/图片，按目录授权。
const authorizedAssetDirectories = new Set<string>();
export function isAuthorizedAsset(filePath: string): boolean {
  const key = assetKey(filePath);
  if (authorizedAssets.has(key)) return true;
  for (const directory of authorizedAssetDirectories) if (key.startsWith(directory)) return true;
  return false;
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
  if (/\.html?$/i.test(canonical)) {
    const directory = assetKey(path.dirname(canonical));
    authorizedAssetDirectories.add(directory.endsWith(path.sep) ? directory : directory + path.sep);
  }
  return canonical;
}

/** 渲染进程不能跨源 fetch asset://，需要字节的预览（Office 文档）经此读取，授权范围与 asset:// 一致。 */
export function readAuthorizedFile(filePath: string): Promise<Buffer> {
  if (typeof filePath !== "string" || !isAuthorizedAsset(filePath)) throw new Error("native.filePreviewScope");
  return fs.promises.readFile(filePath);
}

export async function saveImageAs(
  mainWindow: BrowserWindow,
  filename: string,
  source: { data?: string; url?: string },
  title: string
): Promise<boolean> {
  const result = await dialog.showSaveDialog(mainWindow, {
    title,
    defaultPath: filename || "image.png",
  });
  if (result.canceled || !result.filePath) return false;
  let buffer: Buffer;
  if (source.url) {
    if (!["asset:", "http:", "https:"].includes(new URL(source.url).protocol)) throw new Error("native.imageEmpty");
    // The window's session serves authorized asset:// files and fetches remote images without CORS.
    const response = await mainWindow.webContents.session.fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    buffer = Buffer.from(await response.arrayBuffer());
  } else buffer = Buffer.from(source.data ?? "", "base64");
  if (buffer.length === 0) {
    throw new Error("native.imageEmpty");
  }
  fs.writeFileSync(result.filePath, buffer);
  return true;
}
