import { decodeCommand, type McpServerInfo, type ClaudeCodeSyncIssue } from "@qone/protocol";
import { readObject, revisionOf, type ClaudePaths } from "./source";
import path from "node:path";

export type McpImport = { config: McpServerInfo; secrets: Record<string, string> };
export function expandClaudeVariable(value: string, environment: NodeJS.ProcessEnv = process.env): string {
  return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, key: string, fallback: string | undefined) => {
    const resolved = environment[key] ?? fallback;
    if (resolved === undefined) throw new Error(`Missing environment variable: ${key}`);
    return resolved;
  });
}
function strings(value: unknown): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.values(value).some(v => typeof v !== "string")) throw new Error("Invalid string map");
  return value as Record<string, string>;
}

/** User servers plus the home `.mcp.json`; like Claude Code, the project file wins on a shared name. */
export function claudeMcpServers(paths: ClaudePaths): Map<string, { file: string; raw: unknown }> {
  const servers = new Map<string, { file: string; raw: unknown }>();
  for (const file of [paths.config, paths.projectMcp]) {
    const map = readObject(file)?.mcpServers ?? {};
    if (!map || typeof map !== "object" || Array.isArray(map)) throw new Error("Invalid mcpServers configuration");
    for (const [name, raw] of Object.entries(map)) servers.set(name, { file, raw });
  }
  return servers;
}

export function readClaudeMcp(paths: ClaudePaths): { entries: McpImport[]; issues: ClaudeCodeSyncIssue[]; found: number } {
  const servers = claudeMcpServers(paths);
  const entries: McpImport[] = [];
  const issues: ClaudeCodeSyncIssue[] = [];
  let credentials: Record<string, any> = {};
  try {
    const stored = readObject(path.join(paths.root, ".credentials.json"))?.mcpOAuth ?? {};
    if (typeof stored !== "object" || Array.isArray(stored)) throw new Error();
    credentials = stored;
  } catch { issues.push({ name: ".credentials.json", code: "unreadable" }); }
  for (const [name, { file, raw }] of servers) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) { issues.push({ name, code: "invalid" }); continue; }
    const source = raw as Record<string, any>;
    try {
      const id = `claude-${revisionOf([file, name]).slice(0, 20)}`;
      const secrets: Record<string, string> = {};
      const references = (map: unknown, kind: string) => Object.fromEntries(Object.entries(strings(map)).map(([key, value]) => {
        const secretKey = `mcp.env:${id}/${kind}-${revisionOf(key).slice(0, 16)}`;
        secrets[secretKey] = expandClaudeVariable(value);
        return [key, `$${secretKey}`];
      }));
      const type = source.type ?? (source.command ? "stdio" : "http");
      if (!["stdio", "http", "sse"].includes(type) || source.headersHelper) throw new Error("Unsupported transport or dynamic headers");
      if (source.args !== undefined && (!Array.isArray(source.args) || source.args.some((arg: unknown) => typeof arg !== "string"))) throw new Error("Invalid arguments");
      const config: McpServerInfo = {
        id, name,
        ...(type === "stdio" ? { command: typeof source.command === "string" ? expandClaudeVariable(source.command) : undefined,
          args: (source.args ?? []).map((arg: string) => expandClaudeVariable(arg)), env: references(source.env, "env") }
          : { url: typeof source.url === "string" ? expandClaudeVariable(source.url) : undefined, transport: type, headers: references(source.headers, "header") }),
      };
      if (config.url) {
        const matches = Object.values(credentials).filter((item): item is Record<string, any> => Boolean(item && typeof item === "object" && item.serverName === name && item.serverUrl === config.url));
        const credential = matches.sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
        const hasAuthorization = Object.keys(config.headers ?? {}).some(key => key.toLowerCase() === "authorization");
        if (credential && !hasAuthorization) {
          config.authMode = "oauth";
          if (typeof credential.accessToken === "string" && credential.accessToken && (credential.expiresAt === undefined || typeof credential.expiresAt === "number" && credential.expiresAt > Date.now())) {
            // Refresh tokens may be single-use. Never rotate Claude Code's copy.
            secrets[`mcp.oauth:${id}.tokens`] = JSON.stringify({ access_token: credential.accessToken, token_type: "Bearer", qone_claude_source: true, ...(typeof credential.expiresAt === "number" ? { qone_import_expires_at: credential.expiresAt } : {}), ...(typeof credential.scope === "string" ? { scope: credential.scope } : {}) });
          } else issues.push({ name, code: "needs-auth" });
        }
      }
      if (!decodeCommand(JSON.stringify({ type: "mcp.connect", requestId: "validate", config }))) throw new Error("Invalid MCP configuration");
      entries.push({ config, secrets });
    } catch (error) {
      const missing = error instanceof Error && error.message.startsWith("Missing environment variable: ");
      issues.push({ name, code: missing ? "missing-variable" : "invalid", ...(missing ? { detail: (error as Error).message.slice("Missing environment variable: ".length) } : {}) });
    }
  }
  return { entries, issues, found: servers.size };
}
