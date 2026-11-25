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

const EXTERNAL_BROWSER_MCP_PACKAGES = new Set([
  "@playwright/mcp",
  "playwright-mcp",
  "@executeautomation/playwright-mcp-server",
  "chrome-devtools-mcp",
  "@modelcontextprotocol/server-puppeteer",
  "puppeteer-mcp-server",
  "@browserbasehq/mcp-server-browserbase",
]);
const EXTERNAL_BROWSER_MCP_PATTERN = /(?:^|[\\/\s:@])(?:playwright(?:[-_]mcp)?|chrome[-_]devtools[-_]mcp|server[-_]puppeteer|puppeteer[-_]mcp)(?:$|[@\s\\/:])/i;

/** 识别会启动外置浏览器进程的 MCP（如 Playwright、Chrome DevTools、Puppeteer），避免与内置浏览器冲突。 */
export function isExternalBrowserMcp(config: Pick<McpServerInfo, "id" | "name" | "command" | "args" | "url">): boolean {
  if (config.id === "mcp-playwright") return true;
  const pkg = mcpPackage(config)?.name.toLowerCase();
  if (pkg && (EXTERNAL_BROWSER_MCP_PACKAGES.has(pkg) || EXTERNAL_BROWSER_MCP_PATTERN.test(pkg))) return true;
  const tokens = [config.command, ...(config.args ?? [])].filter((item): item is string => Boolean(item));
  return tokens.some(token => EXTERNAL_BROWSER_MCP_PATTERN.test(token));
}
