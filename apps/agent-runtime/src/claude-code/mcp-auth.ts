import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServerInfo } from "@qone/protocol";
import { claudeExecutable, claudePaths, readObject, type ClaudePaths } from "./source";
import { claudeMcpServers, expandClaudeVariable } from "./mcp";

function matchingCredential(paths: ClaudePaths, name: string, url: string) {
  return Object.values(readObject(path.join(paths.root, ".credentials.json"))?.mcpOAuth ?? {})
    .filter((item): item is Record<string, any> => Boolean(item && typeof item === "object" && (item as any).serverName === name && (item as any).serverUrl === url))
    .sort((a, b) => (b.expiresAt ?? 0) - (a.expiresAt ?? 0))[0];
}

/** Let Claude Code own refresh-token rotation and write its replacement back itself. */
export async function refreshClaudeMcpAuth(paths: ClaudePaths, name: string, url: string): Promise<void> {
  const credential = matchingCredential(paths, name, url);
  if (!credential?.refreshToken || typeof credential.expiresAt !== "number" || credential.expiresAt > Date.now()) return;
  const source = claudeMcpServers(paths).get(name)?.raw as Record<string, any> | undefined;
  const executable = claudeExecutable();
  if (!executable || !source || typeof source.url !== "string" || expandClaudeVariable(source.url) !== url || source.command) return;
  const cwd = await mkdtemp(path.join(os.tmpdir(), "qone-claude-auth-"));
  try {
    await new Promise<void>((resolve) => {
      // get checks only this configured remote server; no model call or browser login.
      execFile(executable, ["mcp", "get", "--", name], { cwd, timeout: 20_000, windowsHide: true, maxBuffer: 1024 * 1024 }, () => resolve());
    });
  } finally { await rm(cwd, { recursive: true, force: true }); }
}

export async function claudeMcpToken(config: Pick<McpServerInfo, "name" | "url">): Promise<string | undefined> {
  if (!config.url) return;
  const paths = claudePaths();
  await refreshClaudeMcpAuth(paths, config.name, config.url);
  const credential = matchingCredential(paths, config.name, config.url);
  if (typeof credential?.accessToken !== "string" || !credential.accessToken || typeof credential.expiresAt === "number" && credential.expiresAt <= Date.now()) return;
  return JSON.stringify({ access_token: credential.accessToken, token_type: "Bearer", qone_claude_source: true,
    ...(typeof credential.expiresAt === "number" ? { qone_import_expires_at: credential.expiresAt } : {}),
    ...(typeof credential.scope === "string" ? { scope: credential.scope } : {}),
  });
}
