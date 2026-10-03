import type { InlineFileSource } from "./message-file-preview";

export interface WorkspaceFileLocation {
  line?: number;
  column?: number;
  endLine?: number;
}

export interface WorkspaceFileTarget extends WorkspaceFileLocation {
  sessionId?: string;
  workspaceId?: string;
  path: string;
  attachment?: InlineFileSource;
}

export const OPEN_WORKSPACE_FILE_EVENT = "qone-open-workspace-file";

/** File evidence may use an absolute path or a path relative to the workspace. */
export function workspaceRelativeFilePath(path: string, workspacePath: string): string | undefined {
  const raw = path.replaceAll("\\", "/");
  const root = workspacePath.replaceAll("\\", "/").replace(/\/+$/, "");
  if (!raw || !root) return undefined;
  const absolute = /^(?:[a-zA-Z]:\/|\/)/.test(raw);
  const windows = /^[a-zA-Z]:\//.test(root) || root.startsWith("//");
  const comparablePath = windows ? raw.toLowerCase() : raw;
  const comparableRoot = windows ? root.toLowerCase() : root;
  if (absolute && !comparablePath.startsWith(`${comparableRoot}/`)) return undefined;
  const relative = absolute ? raw.slice(root.length + 1) : raw;
  const segments: string[] = [];
  for (const segment of relative.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      if (!segments.length) return undefined;
      segments.pop();
    } else segments.push(segment);
  }
  return segments.length ? segments.join("/") : undefined;
}

export function openWorkspaceFile(target: WorkspaceFileTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_WORKSPACE_FILE_EVENT, { detail: target }));
}

/** Keep filesystem roots intact when deriving a document's resource directory. */
export function fileReferenceDirectory(path: string): string | undefined {
  const normalized = path.replaceAll("\\", "/");
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return undefined;
  const directory = normalized.slice(0, separator);
  return separator === 0 || /^[a-z]:$/i.test(directory) ? `${directory}/` : directory;
}

/** Resolve a selected reference without restricting read-only previews to a project. */
export function resolveFileReferencePath(path: string, directory?: string, rootDirectory = directory): string | undefined {
  const raw = path.replaceAll("\\", "/");
  if (!raw || /[\u0000-\u001f\u007f]/.test(raw)) return undefined;
  const base = (raw.startsWith("/") ? rootDirectory ?? directory : directory)?.replaceAll("\\", "/");
  const windowsDirectory = /^[a-z]:\//i.test(base ?? "") || base?.startsWith("//");
  const absolute = /^(?:[a-z]:\/|\/\/)/i.test(raw) || (raw.startsWith("/") && !windowsDirectory);
  if (!absolute && !base) return undefined;
  const joined = absolute ? raw : `${base!.replace(/\/+$/, "")}/${raw}`;
  const prefix = /^[a-z]:\//i.exec(joined)?.[0] ?? (joined.startsWith("//") ? "//" : joined.startsWith("/") ? "/" : "");
  const segments: string[] = [];
  const rootSegments = prefix === "//" ? 2 : 0;
  for (const segment of joined.slice(prefix.length).split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") { if (segments.length > rootSegments) segments.pop(); }
    else segments.push(segment);
  }
  return segments.length ? prefix + segments.join("/") : undefined;
}
