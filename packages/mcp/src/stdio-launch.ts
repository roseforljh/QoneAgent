import { existsSync } from "node:fs";
import path from "node:path";

/** npm's Windows npx shim is a batch file, which cannot run with spawn(shell: false). */
export function resolveStdioLaunch(
  command: string,
  args: string[],
  platform = process.platform,
  searchPath = process.env.Path ?? process.env.PATH ?? "",
): { command: string; args: string[] } {
  if (platform !== "win32" || command.toLowerCase() !== "npx") return { command, args };
  const directories = searchPath.split(";").map((entry) => entry.trim().replace(/^"|"$/g, "")).filter(Boolean);
  for (const directory of directories) {
    const executable = path.join(directory, "npx.exe");
    if (existsSync(executable)) return { command: executable, args };
    const shim = path.join(directory, "npx.cmd");
    const cli = path.join(directory, "node_modules", "npm", "bin", "npx-cli.js");
    if (!existsSync(shim) || !existsSync(cli)) continue;
    const node = directories.map((entry) => path.join(entry, "node.exe")).find(existsSync);
    if (node) return { command: node, args: [cli, ...args] };
  }
  throw new Error("MCP_NPX_UNAVAILABLE");
}
