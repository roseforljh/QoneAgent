import type { McpServerInfo } from "./index";

/** Secret references used by both stdio environments and HTTP headers. */
export function mcpValueSecretKeys(config: Pick<McpServerInfo, "env" | "headers">): string[] {
  return [...new Set([...Object.values(config.env ?? {}), ...Object.values(config.headers ?? {})]
    .filter(value => value.startsWith("$mcp.env:")).map(value => value.slice(1)))];
}

const packageRunners = new Set(["npx", "bunx", "pnpx", "uvx"]);
/** The package a runner such as `npx -y pkg@latest` launches, without its version. */
export function mcpPackage(config: Pick<McpServerInfo, "command" | "args">): { runner: string; name: string; rest: string[] } | undefined {
  const runner = config.command?.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
  if (!runner || !packageRunners.has(runner)) return undefined;
  const args = config.args ?? [];
  const index = args.findIndex(arg => !arg.startsWith("-"));
  return index < 0 ? undefined : { runner, name: args[index]!.replace(/(.)@[^/@]*$/, "$1"), rest: args.slice(index + 1) };
}
/**
 * One identity for the same server however it is launched: `npx -y pkg@latest`
 * equals `npx pkg`; remote servers compare by URL.
 */
export function mcpServerIdentity(config: Pick<McpServerInfo, "command" | "args" | "url">): string | undefined {
  if (config.url) return `url:${config.url}`;
  if (!config.command) return undefined;
  const pkg = mcpPackage(config);
  return pkg ? `pkg:${[pkg.name, ...pkg.rest].join("\0")}` : `cmd:${[config.command, ...config.args ?? []].join("\0")}`;
}
