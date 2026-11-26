import { mcpPackage } from "@qone/protocol";

/** One MCP server described by a pasted install command, URL or JSON snippet. */
export type ParsedMcp = { name: string; command?: string; args?: string[]; url?: string; transport?: "http" | "sse"; env: Record<string, string>; headers: Record<string, string> };

/** Shell-style split: whitespace separates, single/double quotes group, backslash escapes inside double quotes. */
export function splitCommandLine(line: string): string[] {
  const tokens: string[] = [];
  let current = "", quote: string | undefined, started = false;
  for (let index = 0; index < line.length; index++) {
    const char = line[index]!;
    if (quote) {
      if (char === quote) quote = undefined;
      else if (char === "\\" && quote === "\"" && (line[index + 1] === "\"" || line[index + 1] === "\\")) current += line[++index];
      else current += char;
    } else if (char === "\"" || char === "'") { quote = char; started = true; }
    else if (/\s/.test(char)) { if (started) tokens.push(current); current = ""; started = false; }
    else { current += char; started = true; }
  }
  if (quote) throw new Error("unclosed quote");
  if (started) tokens.push(current);
  return tokens;
}

const assignment = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const isUrl = (value: string) => /^https?:\/\/\S+$/i.test(value);

/** A readable default name: the package without scope, version or "mcp"/"server" affixes, or the site's domain. */
export function defaultMcpName(config: Pick<ParsedMcp, "command" | "args" | "url">): string {
  if (config.url) {
    const labels = new URL(config.url).hostname.split(".");
    return labels.length > 1 ? labels[labels.length - 2]! : labels[0]!;
  }
  const pkg = mcpPackage(config)?.name;
  const [, scope, bare] = /^(?:@([^/]+)\/)?(.+)$/.exec(pkg ?? config.command!.replace(/^.*[\\/]/, "").replace(/\.(cmd|exe|bat|ps1|js|py)$/i, ""))!;
  const name = bare!.replace(/^(mcp-server-|server-|mcp-)/i, "").replace(/(-mcp-server|-mcp|-server)$/i, "");
  // `@playwright/mcp` names nothing by itself; the scope is the product.
  return !name || /^(mcp|server|mcp-server)$/i.test(name) ? scope ?? bare! : name;
}

function fromJson(name: string | undefined, raw: unknown): ParsedMcp {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new Error("invalid server");
  const source = raw as Record<string, unknown>;
  const strings = (value: unknown) => Object.fromEntries(Object.entries(value && typeof value === "object" ? value : {}).filter(([, item]) => typeof item === "string")) as Record<string, string>;
  const url = [source.url, source.serverUrl, source.httpUrl].find((item): item is string => typeof item === "string");
  const config: ParsedMcp = url
    ? { name: "", url, transport: source.type === "sse" || source.transport === "sse" ? "sse" : "http", env: {}, headers: strings(source.headers) }
    : typeof source.command === "string"
      ? { name: "", command: source.command, args: Array.isArray(source.args) ? source.args.map(String) : [], env: strings(source.env), headers: {} }
      : (() => { throw new Error("server has no command or url"); })();
  return { ...config, name: name ?? defaultMcpName(config) };
}

// Options of `claude|codex|gemini mcp add` that take a value; any other option is a switch.
const valueFlags = new Set(["-e", "--env", "-H", "--header", "-t", "--transport", "-s", "--scope", "--url", "--client-id", "--callback-port", "--timeout", "--bearer-token-env-var", "--include-tools", "--exclude-tools"]);

/** `<tool> mcp add [options] <name> [--] <command-or-url> [args...]` as used by Claude Code, Codex and Gemini CLIs. */
function fromAddCommand(tokens: string[]): ParsedMcp[] {
  if (tokens[0] === "add-json") return [fromJson(tokens[1], JSON.parse(tokens[2] ?? ""))];
  const env: Record<string, string> = {}, headers: Record<string, string> = {};
  let transport: string | undefined, url: string | undefined, index = 1;
  const positional: string[] = [];
  // Options stop at `--` or at the command after the name; everything later belongs to the server.
  for (; index < tokens.length && positional.length < 2; index++) {
    const token = tokens[index]!;
    if (token === "--") { index++; break; }
    if (!token.startsWith("-")) { positional.push(token); continue; }
    const equals = token.startsWith("--") ? token.indexOf("=") : -1;
    const flag = equals > 0 ? token.slice(0, equals) : token;
    if (!valueFlags.has(flag)) continue;
    const value = equals > 0 ? token.slice(equals + 1) : tokens[++index] ?? "";
    if (flag === "-e" || flag === "--env") { const match = assignment.exec(value); if (match) env[match[1]!] = match[2]!; }
    else if (flag === "-H" || flag === "--header") { const colon = value.indexOf(":"); if (colon > 0) headers[value.slice(0, colon).trim()] = value.slice(colon + 1).trim(); }
    else if (flag === "-t" || flag === "--transport") transport = value;
    else if (flag === "--url") url = value;
  }
  const [name, target] = positional;
  const rest = tokens.slice(index);
  const commandOrUrl = url ?? target ?? rest.shift();
  if (!name || !commandOrUrl) throw new Error("missing name or command");
  if (isUrl(commandOrUrl)) return [{ name, url: commandOrUrl, transport: transport === "sse" ? "sse" : "http", env, headers }];
  return [{ name, command: commandOrUrl, args: rest, env, headers }];
}

/** Parses whatever an MCP README tells you to run or paste. Throws when nothing usable is recognised. */
export function parseMcpInput(input: string): ParsedMcp[] {
  const text = input.trim();
  if (!text) return [];
  if (text.startsWith("{")) {
    const data = JSON.parse(text) as Record<string, unknown>;
    const map = (data.mcpServers ?? data.servers ?? (data.mcp as Record<string, unknown> | undefined)?.servers) as Record<string, unknown> | undefined;
    if (map && typeof map === "object") return Object.entries(map).map(([name, raw]) => fromJson(name, raw));
    if ("command" in data || "url" in data) return [fromJson(undefined, data)];
    return Object.entries(data).map(([name, raw]) => fromJson(name, raw));
  }
  // Line continuations from copied multi-line commands.
  const tokens = splitCommandLine(text.replace(/\s*(\\|\^|`)\r?\n\s*/g, " "));
  const env: Record<string, string> = {};
  while (tokens[0] && assignment.test(tokens[0])) { const match = assignment.exec(tokens.shift()!)!; env[match[1]!] = match[2]!; }
  const add = tokens.findIndex((token, index) => token === "mcp" && (tokens[index + 1] === "add" || tokens[index + 1] === "add-json"));
  if (add >= 0 && add <= 1) {
    return fromAddCommand(tokens.slice(add + 1)).map(item => ({ ...item, env: { ...env, ...item.env } }));
  }
  const [first, ...rest] = tokens;
  if (!first) throw new Error("empty command");
  const config: ParsedMcp = isUrl(first)
    ? { name: "", url: first, transport: /\/sse\/?$/i.test(new URL(first).pathname) ? "sse" : "http", env: {}, headers: {} }
    : { name: "", command: first, args: rest, env, headers: {} };
  return [{ ...config, name: defaultMcpName(config) }];
}

// 仅识别明确的文档模板占位符，避免误伤 my-service、todo-app 等真实参数值。
const placeholderWord = /<[^>]*>|\$\{[^}]*\}|\byour[-_ ]?[a-z0-9_-]*|\bx{4,}\b|\*{3,}|(?:^|[-_:\s])\.{3,}$|\b(?:change[-_ ]?me|replace[-_ ]?me|placeholder)\b|^\s*(?:api[-_ ]?key|token|secret|key)\s*$/gi;
/** Values a README expects you to replace, e.g. `YOUR_API_KEY`, `<token>` or `${API_KEY}`. Empty values are optional, not placeholders. */
export function isPlaceholder(value: string): boolean {
  if (!value.trim() || value.startsWith("$mcp.env:")) return false;
  placeholderWord.lastIndex = 0;
  return placeholderWord.test(value);
}
/** The value with its placeholder words removed, keeping prefixes such as `Bearer `. */
export function withoutPlaceholder(value: string): string {
  return value.replace(placeholderWord, "").replace(/\s+$/, " ").trimStart();
}

export type McpField = { id: string; index: number; server: string; label: string; secret: boolean; required: boolean; prefill: string; apply: (item: ParsedMcp, value: string) => void };
/**
 * Every key and header is shown for review (a fake value cannot be told from a real one), and
 * placeholders must be replaced. Arguments are listed only when they are placeholders.
 */
export function configFields(items: ParsedMcp[]): McpField[] {
  const field = (index: number, item: ParsedMcp, id: string, label: string, value: string, secret: boolean, apply: McpField["apply"]): McpField => {
    const required = isPlaceholder(value);
    return { id: `${index}:${id}`, index, server: item.name, label, secret, required, prefill: required ? withoutPlaceholder(value) : value, apply };
  };
  return items.flatMap((item, index) => [
    ...Object.entries(item.env).map(([key, value]) => field(index, item, `env:${key}`, key, value, true, (target, next) => { target.env[key] = next; })),
    ...Object.entries(item.headers).map(([key, value]) => field(index, item, `header:${key}`, key, value, true, (target, next) => { target.headers[key] = next; })),
    ...(item.args ?? []).flatMap((arg, position) => isPlaceholder(arg) ? [field(index, item, `arg:${position}`, arg, arg, false, (target, next) => { target.args![position] = next; })] : []),
  ]);
}
/** Optional values may stay empty; a replaced placeholder needs real content beyond its kept prefix. */
export const fieldComplete = (field: McpField, value: string) => !isPlaceholder(value)
  && (!field.required || (Boolean(value.trim()) && value.trim() !== field.prefill.trim()));
