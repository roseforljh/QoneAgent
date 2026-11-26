import { readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import path from "node:path";

const OVERRIDE_CANDIDATES = ["AGENTS.override.md"] as const;
const INSTRUCTION_GROUPS = [
  ["AGENTS.md", "AGENTS.MD"],
  ["AGENT.md", "AGENT.MD"],
  ["CLAUDE.md", "CLAUDE.MD"],
] as const;

function readInstructionFile(file: string): { path: string; content: string; realPath: string } | undefined {
  try {
    if (!statSync(file).isFile()) return undefined;
    const realPath = realpathSync(file);
    const content = readFileSync(file, "utf8").replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
    return { path: file, content, realPath };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function listWorkspaceEntries(cwd: string): Set<string> {
  try {
    return new Set(readdirSync(cwd));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return new Set();
    throw error;
  }
}

/** 区分大小写读取工作区根目录下的项目指令文件（对齐 Claude Code / Codex / Pi 约定）；AGENTS.override.md 独占覆盖，否则按固定顺序合并 AGENTS.md、AGENT.md 与 CLAUDE.md 并按真实路径去重，确保提示词前缀稳定。 */
export function workspaceInstructions(cwd: string): { path: string; content: string }[] {
  const entries = listWorkspaceEntries(cwd);
  if (entries.size === 0) return [];

  for (const name of OVERRIDE_CANDIDATES) {
    if (!entries.has(name)) continue;
    const override = readInstructionFile(path.join(cwd, name));
    if (override) return [{ path: override.path, content: override.content }];
  }

  const files: { path: string; content: string }[] = [];
  const seen = new Set<string>();
  for (const candidates of INSTRUCTION_GROUPS) {
    for (const name of candidates) {
      if (!entries.has(name)) continue;
      const entry = readInstructionFile(path.join(cwd, name));
      if (!entry?.content.trim()) continue;
      const key = process.platform === "win32" ? entry.realPath.toLowerCase() : entry.realPath;
      if (!seen.has(key)) {
        seen.add(key);
        files.push({ path: entry.path, content: entry.content });
      }
      break;
    }
  }
  return files;
}
