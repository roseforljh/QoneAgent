import { lstat, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { WorkspaceFileInfo, WorkspaceGitEntry } from "@qone/protocol";

export const MAX_PREVIEW_BYTES = 512_000;

function inside(root: string, target: string) {
  const relative = path.relative(root, target);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Check both lexical paths and existing ancestors (including junctions). */
export async function resolveWorkspacePath(root: string, relative: string): Promise<string> {
  const base = await realpath(root);
  const target = path.resolve(base, relative);
  if (!inside(base, target)) throw new Error("Path is outside the workspace");
  let ancestor = target;
  while (true) {
    try {
      if (!inside(base, await realpath(ancestor))) throw new Error("Path is outside the workspace");
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return target;
}

export async function listWorkspaceFiles(root: string, relative = ""): Promise<WorkspaceFileInfo[]> {
  const directory = await resolveWorkspacePath(root, relative);
  const entries = await readdir(directory, { withFileTypes: true });
  return entries.filter((entry) => entry.name !== ".git").map((entry) => ({
    path: path.relative(root, path.join(directory, entry.name)).split(path.sep).join("/"),
    kind: entry.isDirectory() ? "directory" as const : "file" as const,
  })).sort((a, b) => Number(b.kind === "directory") - Number(a.kind === "directory") || a.path.localeCompare(b.path));
}

export async function readWorkspaceFile(root: string, relative: string) {
  const target = await resolveWorkspacePath(root, relative);
  if (!(await stat(target)).isFile()) throw new Error("Not a regular file");
  const bytes = new Uint8Array(await Bun.file(target).slice(0, MAX_PREVIEW_BYTES + 1).arrayBuffer());
  const truncated = bytes.length > MAX_PREVIEW_BYTES;
  const preview = bytes.subarray(0, MAX_PREVIEW_BYTES);
  if (preview.includes(0)) return { content: "", binary: true, truncated: false };
  return { content: new TextDecoder().decode(preview, { stream: truncated }), binary: false, truncated };
}

async function git(root: string, args: string[], allowed = [0], limit = MAX_PREVIEW_BYTES) {
  const child = Bun.spawn(["git", "--literal-pathspecs", "-C", root, ...args], {
    stdout: "pipe", stderr: "pipe", env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
  });
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; child.kill(); }, 15_000);
  const consume = async (stream: ReadableStream<Uint8Array>, max: number) => {
    const chunks: Uint8Array[] = [];
    let size = 0;
    let truncated = false;
    for await (const chunk of stream) {
      const length = Math.min(chunk.length, Math.max(0, max - size));
      if (length) chunks.push(chunk.slice(0, length));
      size += length;
      if (length < chunk.length) truncated = true;
    }
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    return { text: new TextDecoder().decode(bytes, { stream: truncated }), truncated };
  };
  try {
    const [out, err, code] = await Promise.all([consume(child.stdout, limit), consume(child.stderr, 8000), child.exited]);
    if (timedOut) throw new Error("Git command timed out");
    if (!allowed.includes(code)) throw new Error(err.text.trim() || `Git exited with code ${code}`);
    return { ...out, code };
  } finally { clearTimeout(timer); }
}

export function parseGitStatus(raw: string): WorkspaceGitEntry[] {
  const records = raw.split("\0");
  const entries: WorkspaceGitEntry[] = [];
  for (let i = 0; i < records.length; i++) {
    const row = records[i];
    if (!row) continue;
    const code = row.slice(0, 2);
    const originalPath = /[RC]/.test(code) ? records[++i] : undefined;
    entries.push({ code, path: row.slice(3), ...(originalPath ? { originalPath } : {}) });
  }
  return entries;
}

export async function workspaceGit(root: string) {
  // porcelain paths are repository-relative even when -C points to a subfolder.
  const repository = (await git(root, ["rev-parse", "--show-toplevel"])).text.trim();
  const result = await git(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."], [0], 8_000_000);
  if (result.truncated) throw new Error("Too many Git changes to list");
  const entries = parseGitStatus(result.text).map((entry) => ({
    ...entry,
    path: path.relative(root, path.resolve(repository, entry.path)).split(path.sep).join("/"),
    originalPath: entry.originalPath ? path.relative(root, path.resolve(repository, entry.originalPath)).split(path.sep).join("/") : undefined,
  }));
  return { entries, status: entries.map((entry) => `${entry.code} ${entry.path}`).join("\n") };
}

export async function workspaceDiff(root: string, relative: string, scope: "staged" | "unstaged" = "unstaged") {
  const target = await resolveWorkspacePath(root, relative);
  const { entries } = await workspaceGit(root);
  const normalized = path.relative(root, target).split(path.sep).join("/");
  const entry = entries.find((item) => item.path === normalized);
  if (!entry) return { diff: "", truncated: false };
  if (entry.code === "??") {
    if (scope === "staged") return { diff: "", truncated: false };
    if ((await lstat(target)).isSymbolicLink()) throw new Error("Symbolic link preview is unavailable");
    const result = await git(root, ["diff", "--no-index", "--no-ext-diff", "--no-textconv", "--no-color", "--", "/dev/null", normalized], [0, 1]);
    return { diff: result.text, truncated: result.truncated };
  }
  const paths = [normalized];
  if (entry.originalPath) {
    // Do not accept client-provided source paths for a rename.
    await resolveWorkspacePath(root, entry.originalPath);
    paths.push(entry.originalPath);
  }
  const result = await git(root, ["diff", ...(scope === "staged" ? ["--cached"] : ["HEAD"]), "--no-ext-diff", "--no-textconv", "--no-color", "--find-renames", "--", ...paths]);
  return { diff: result.text, truncated: result.truncated };
}
