import { createHash } from "node:crypto";
import { z } from "zod";
import type { McpServerConfig } from "./index";

const tool = z.object({
  name: z.string().min(1), description: z.string().optional(),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  annotations: z.object({ readOnlyHint: z.boolean().optional() }).passthrough().optional(),
}).passthrough();
export type McpToolMetadata = z.infer<typeof tool>;
const catalog = z.object({ fingerprint: z.string(), tools: z.array(tool) });
export interface McpCatalogStore {
  get(key: string): unknown;
  set(key: string, value: unknown): void;
  delete(key: string): void;
}
export const catalogKey = (id: string) => `mcp.tools.v1:${id}`;

/** Only transport/auth fields belong in the cache identity; never UI state. */
export function connectionConfig(config: McpServerConfig): McpServerConfig {
  const { id, name, command, args, env, headers, url, transport, tokenEnv, cwd, oauth, authMode, oauthClientId } = config;
  return { id, name, command, args, env, headers, url, transport, tokenEnv, cwd, oauth, authMode, oauthClientId };
}
const canonical = (value: unknown): unknown => Array.isArray(value) ? value.map(canonical)
  : value && typeof value === "object" ? Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, canonical(v)])) : value;
export function configFingerprint(config: McpServerConfig): string {
  return createHash("sha256").update(JSON.stringify(canonical(connectionConfig(config)))).digest("hex");
}
export function readCatalog(value: unknown, fingerprint: string): McpToolMetadata[] | undefined {
  const parsed = catalog.safeParse(value);
  return parsed.success && parsed.data.fingerprint === fingerprint ? parsed.data.tools : undefined;
}
