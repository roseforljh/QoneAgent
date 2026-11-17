import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
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

/**
 * `npx <pkg>` keeps a whole npm process (~110 MB) alive as the parent of the
 * real server for the entire session. Let npx install/update the package as
 * before, then start the package's bin with Node directly. Any layout this does
 * not recognise keeps the plain npx launch.
 */
export async function resolveMcpStdioLaunch(
  command: string,
  args: string[],
  options: { env?: Record<string, string>; cwd: string; signal: AbortSignal },
): Promise<{ command: string; args: string[] }> {
  const launch = resolveStdioLaunch(command, args);
  if (command.toLowerCase() !== "npx") return launch;
  let index = 0;
  while (args[index] === "-y" || args[index] === "--yes") index++;
  const spec = args[index];
  if (!spec || spec.startsWith("-")) return launch;
  try {
    const probe = resolveStdioLaunch("npx", ["--yes", "--package", spec, "--call", "node -p process.env.PATH"]);
    const pathOutput = await new Promise<string>((resolve, reject) => {
      execFile(probe.command, probe.args, { env: options.env, cwd: options.cwd, signal: options.signal, timeout: 60_000, windowsHide: true },
        (error, stdout) => error ? reject(error) : resolve(stdout));
    });
    const binDirectory = pathOutput.trim().split(path.delimiter)
      .find((entry) => /[\\/]_npx[\\/][^\\/]+[\\/]node_modules[\\/]\.bin$/.test(entry));
    if (!binDirectory) return launch;
    const root = path.resolve(binDirectory, "..", "..");
    const packages = Object.keys((JSON.parse(await readFile(path.join(root, "package.json"), "utf8")) as { dependencies?: object }).dependencies ?? {});
    if (packages.length !== 1) return launch;
    const packageDirectory = path.join(root, "node_modules", packages[0]!);
    const manifest = JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")) as { bin?: string | Record<string, string> };
    const unscoped = packages[0]!.split("/").pop()!;
    const bins = typeof manifest.bin === "string" ? { [unscoped]: manifest.bin } : manifest.bin ?? {};
    const entries = Object.values(bins);
    // Same choice as npx: the only bin, otherwise the one named after the package.
    const bin = entries.length === 1 ? entries[0] : bins[unscoped];
    if (!bin) return launch;
    const script = path.join(packageDirectory, bin);
    const source = await readFile(script, "utf8");
    if (!/\.[cm]?js$/i.test(script) && !/^#!.*\bnode\b/.test(source)) return launch;
    const node = /^node(\.exe)?$/i.test(path.basename(probe.command)) ? probe.command : "node";
    return { command: node, args: [script, ...args.slice(index + 1)] };
  } catch (error) {
    if (options.signal.aborted) throw options.signal.reason;
    return launch;
  }
}
