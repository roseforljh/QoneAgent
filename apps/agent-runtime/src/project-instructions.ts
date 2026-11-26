import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const PONYTAIL_START = "<!-- QoneAgent managed: ponytail:start -->";
const PONYTAIL_END = "<!-- QoneAgent managed: ponytail:end -->";
const MANAGED_BLOCK = new RegExp(`${escapeRegExp(PONYTAIL_START)}[\\s\\S]*?${escapeRegExp(PONYTAIL_END)}(?:\\r?\\n)?`, "g");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function removeManagedPrompt(content: string): string {
  return content.replace(MANAGED_BLOCK, "");
}

function lineEnding(content: string | undefined): string {
  return content?.includes("\r\n") ? "\r\n" : "\n";
}

async function readExisting(file: string): Promise<string | undefined> {
  try {
    return await readFile(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** 仅清理历史版本曾经写入工作区 AGENTS.md 的 ponytail 托管块，绝不向用户项目主动写入或创建文件。 */
export async function cleanManagedPonytailProjectInstructions(cwd: string): Promise<void> {
  try {
    if (!(await stat(cwd)).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const file = path.join(cwd, "AGENTS.md");
  const existing = await readExisting(file);
  if (existing === undefined || !existing.includes(PONYTAIL_START)) return;
  const cleaned = removeManagedPrompt(existing).trim();
  if (!cleaned) {
    await unlink(file);
    return;
  }
  const next = `${cleaned}${lineEnding(existing)}`;
  if (next !== existing) await writeFile(file, next, "utf8");
}
