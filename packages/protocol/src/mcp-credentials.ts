import { z } from "zod";
import type { McpServerInfo } from "./index";
import { mcpValueSecretKeys } from "./mcp-config";

/** Native-only request/reply: the main process intercepts these before renderer delivery. */
export type McpCredentialsRequest = { type: "mcp.credentials.request"; requestId: string; serverId: string; keys: string[] };
export type McpCredentialsRestored = { type: "mcp.credentials.restored"; requestId: string; values: Record<string, string>; ok: boolean };
export const mcpCredentialsRestoredSchema = z.object({
  type: z.literal("mcp.credentials.restored"), requestId: z.string().min(1),
  values: z.record(z.string(), z.string()), ok: z.boolean(),
});

export function mcpCredentialKeys(config: Pick<McpServerInfo, "id" | "env" | "headers" | "authMode" | "oauth">): string[] {
  const oauth = config.authMode === "oauth"
    ? [`mcp.oauth:${config.id}.client`, `mcp.oauth:${config.id}.tokens`]
    : config.authMode || config.oauth ? [config.oauth?.tokenSecretKey ?? `mcp.oauth:${config.id}`] : [];
  return [...new Set([...oauth, ...mcpValueSecretKeys(config)])];
}
