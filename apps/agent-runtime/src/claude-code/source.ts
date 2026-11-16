import os from "node:os";
import path from "node:path";
import { existsSync, readFileSync, statSync } from "node:fs";
import { createHash } from "node:crypto";

export function claudePaths() {
  const home = os.homedir();
  const configured = process.env.CLAUDE_CONFIG_DIR?.trim();
  const root = configured ? path.resolve(configured) : path.join(home, ".claude");
  // Claude Code loads `.mcp.json` from the project and its ancestors; the home one reaches every project of the user.
  return { root, config: configured ? path.join(root, ".claude.json") : path.join(home, ".claude.json"), projectMcp: path.join(home, ".mcp.json") };
}
export type ClaudePaths = ReturnType<typeof claudePaths>;
export function readOptional(file: string): string | undefined {
  try { return readFileSync(file, "utf8"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new Error(`Cannot read ${file}`); }
}
export function readObject(file: string): Record<string, any> | undefined {
  const text = readOptional(file);
  if (text === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(text);
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error();
    return data as Record<string, any>;
  } catch { throw new Error(`Invalid JSON: ${file}`); }
}
export function claudeExecutable(): string | undefined {
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT").split(";").filter(ext => ext.toLowerCase() === ".exe") : [""];
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    for (const ext of extensions) {
      const file = path.join(dir.replace(/^"|"$/g, ""), `claude${ext.toLowerCase()}`);
      try { if (statSync(file).isFile()) return file; } catch {}
    }
  }
}
export function claudeInstalled(paths: ClaudePaths): boolean {
  if (existsSync(paths.config) || existsSync(paths.root)) return true;
  const extensions = process.platform === "win32" ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.PS1").split(";") : [""];
  return (process.env.PATH ?? "").split(path.delimiter).some(dir => extensions.some(ext => {
    try { return statSync(path.join(dir.replace(/^"|"$/g, ""), `claude${ext.toLowerCase()}`)).isFile(); } catch { return false; }
  }));
}
export const revisionOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
