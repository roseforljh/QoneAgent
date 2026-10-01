import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { filePreviewKind, mediaMimeTypeFromName, type FilePreviewInfo } from "@qone/protocol";
import { decide } from "./permissions";
import { MAX_PREVIEW_BYTES } from "./workspace";
import { runtimeError } from "./runtime-localization";

export async function resolveFilePreviewPath(input: string, cwd?: string): Promise<string> {
  if (!input || /[\u0000-\u001f\u007f]/.test(input)) throw runtimeError("file-preview.invalidPath");
  if (!cwd && !path.isAbsolute(input)) throw runtimeError("file-preview.workspaceRequired");
  const target = path.resolve(cwd ?? process.cwd(), input);
  try { return await realpath(target); } catch (error) {
    // On Windows, a /docs/... destination can be a Markdown root-relative
    // link. Prefer a real drive-root file; only try the workspace on ENOENT.
    if (process.platform !== "win32" || !cwd || !/^\/(?!\/)/.test(input) || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return realpath(path.resolve(cwd, `.${input}`));
  }
}

export function decodePreviewText(bytes: Uint8Array, truncated: boolean): string | undefined {
  const utf16 = bytes[0] === 0xff && bytes[1] === 0xfe ? "utf-16le" : bytes[0] === 0xfe && bytes[1] === 0xff ? "utf-16be" : undefined;
  if (!utf16 && bytes.includes(0)) return undefined;
  try {
    const text = new TextDecoder(utf16 ?? "utf-8", { fatal: true }).decode(bytes, { stream: truncated });
    return /[\u0000-\u0008\u000b\u000e-\u001f]/.test(text) ? undefined : text;
  } catch { return undefined; }
}

/** A user-selected, read-only preview is separate from workspace-scoped tools. */
export async function readFilePreview(input: string, cwd?: string, full = false): Promise<FilePreviewInfo> {
  const absolutePath = await resolveFilePreviewPath(input, cwd);
  if (decide({ toolName: "read", workspacePath: cwd, args: { path: absolutePath } }) === "deny") throw runtimeError("file-preview.permissionDenied");
  const info = await stat(absolutePath);
  if (!info.isFile()) throw runtimeError("file-preview.notRegularFile");
  const file = Bun.file(absolutePath);
  const mimeType = mediaMimeTypeFromName(absolutePath) ?? file.type ?? "application/octet-stream";
  const mediaKind = filePreviewKind(absolutePath, mimeType, true);
  if (mediaKind !== "binary" && mimeType !== "image/svg+xml") return { absolutePath, kind: mediaKind, mimeType, size: info.size, truncated: false };
  const bytes = new Uint8Array(await (full ? file : file.slice(0, MAX_PREVIEW_BYTES)).arrayBuffer());
  const truncated = !full && info.size > bytes.length;
  const content = decodePreviewText(bytes, truncated);
  const kind = filePreviewKind(absolutePath, mimeType, content === undefined);
  return { absolutePath, kind, mimeType, size: info.size, ...(content === undefined ? {} : { content }), truncated: content !== undefined && truncated };
}
