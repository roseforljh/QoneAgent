import { readFile, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";

const PONYTAIL_START = "<!-- QoneAgent managed: ponytail:start -->";
const PONYTAIL_END = "<!-- QoneAgent managed: ponytail:end -->";
const FRONTMATTER = /^---\r?\n[\s\S]*?\r?\n---\r?\n?/;
const MANAGED_BLOCK = new RegExp(`${escapeRegExp(PONYTAIL_START)}[\\s\\S]*?${escapeRegExp(PONYTAIL_END)}(?:\\r?\\n)?`, "g");

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function promptFromSkill(skillContent: string): string {
  return skillContent.replace(FRONTMATTER, "").trim();
}

function removeManagedPrompt(content: string): string {
  return content.replace(MANAGED_BLOCK, "");
}

function managedPrompt(skillContent: string): string {
  return `${PONYTAIL_START}\n${promptFromSkill(skillContent)}\n${PONYTAIL_END}`;
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

/** Keep the managed prompt separate so disabling it cannot remove project rules. */
export async function syncPonytailProjectInstructions(cwd: string, enabled: boolean, skillPath: string): Promise<void> {
  try {
    if (!(await stat(cwd)).isDirectory()) return;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  const file = path.join(cwd, "AGENTS.md");
  const existing = await readExisting(file);
  if (!enabled) {
    if (existing === undefined || !existing.includes(PONYTAIL_START)) return;
    const cleaned = removeManagedPrompt(existing).trim();
    if (!cleaned) {
      await unlink(file);
      return;
    }
    const next = `${cleaned}${lineEnding(existing)}`;
    if (next !== existing) await writeFile(file, next, "utf8");
    return;
  }

  const base = removeManagedPrompt(existing ?? "").trim();
  const newline = lineEnding(existing);
  const prompt = managedPrompt(await readFile(skillPath, "utf8")).replaceAll("\n", newline);
  const next = base ? `${base}${newline}${newline}${prompt}${newline}` : `${prompt}${newline}`;
  if (next !== existing) await writeFile(file, next, "utf8");
}
