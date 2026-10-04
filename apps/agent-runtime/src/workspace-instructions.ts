import { readFileSync, statSync } from "node:fs";
import path from "node:path";

/** Use Pi's context-file precedence only inside the selected workspace root. */
export function workspaceInstructions(cwd: string): { path: string; content: string }[] {
  for (const name of ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"]) {
    const file = path.join(cwd, name);
    try {
      if (!statSync(file).isFile()) continue;
      return [{ path: file, content: readFileSync(file, "utf8").replace(/^\uFEFF/, "") }];
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return [];
}
