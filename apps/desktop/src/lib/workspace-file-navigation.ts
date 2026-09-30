export interface WorkspaceFileLocation {
  line?: number;
  column?: number;
  endLine?: number;
}

export interface WorkspaceFileTarget extends WorkspaceFileLocation {
  sessionId: string;
  workspaceId: string;
  path: string;
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
