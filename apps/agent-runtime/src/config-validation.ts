import { decodeCommand } from "@qone/protocol";
import { mcpServersFrom } from "@qone/database";
import { containsSecretConfig } from "./secrets";

type Json = Record<string, unknown>;
const object = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);

/** External files cross the same validation boundary as commands; errors never quote credential values. */
export function validateSettings(data: Json) {
  for (const key of ["mcpServers", "models", "permissions", "preferences"]) {
    if (data[key] !== undefined && !object(data[key])) throw new Error(`"${key}" must be an object`);
  }
  for (const [id, raw] of Object.entries((data.mcpServers ?? {}) as Json)) {
    const config = mcpServersFrom({ [id]: raw })[0];
    if (!object(raw) || (raw.disabled !== undefined && typeof raw.disabled !== "boolean") ||
      (raw.type !== undefined && !["stdio", "http", "sse"].includes(String(raw.type))) ||
      !config || !decodeCommand(JSON.stringify({ type: "mcp.connect", requestId: "settings", config }))) {
      throw new Error(`MCP service ${JSON.stringify(id)} is not a valid configuration`);
    }
  }
  for (const [id, raw] of Object.entries((data.models ?? {}) as Json)) {
    if (!object(raw)) throw new Error(`Model ${JSON.stringify(id)} must be an object`);
    const { provider, model, enabled, ...config } = raw;
    if (containsSecretConfig(config)) throw new Error("Model API keys belong in Settings › Models (encrypted), not in settings.json");
    if (!decodeCommand(JSON.stringify({ type: "model.upsert", requestId: "settings", config: { id, provider, model, enabled, config } }))) {
      throw new Error(`Model ${JSON.stringify(id)} is not a valid configuration`);
    }
  }
  for (const [subject, rules] of Object.entries((data.permissions ?? {}) as Json)) {
    if (!object(rules) || Object.entries(rules).some(([permission, decision]) => !decodeCommand(JSON.stringify({ type: "permission.set", requestId: "settings", subjectId: subject, permission, decision })))) {
      throw new Error(`Permissions for ${JSON.stringify(subject)} are not valid`);
    }
  }
  const preferences = (data.preferences ?? {}) as Json;
  const compaction = preferences["compaction.settings"];
  if (compaction !== undefined && (!object(compaction) || !decodeCommand(JSON.stringify({ ...compaction, type: "compaction.settings.set", requestId: "settings" })))) {
    throw new Error("preferences[\"compaction.settings\"] must have autoCompactionEnabled and compactionThreshold (50–95)");
  }
  if (preferences["memory.enabled"] !== undefined && typeof preferences["memory.enabled"] !== "boolean") throw new Error("memory.enabled must be true or false");
  const memoryModel = preferences["memory.model"];
  if (memoryModel !== undefined && !decodeCommand(JSON.stringify({ type: "memory.model.set", requestId: "settings", modelId: memoryModel }))) {
    throw new Error("memory.model must be a configured model ID or null");
  }
  for (const key of ["servers.list", "servers.groups"]) {
    if (preferences[key] !== undefined && !Array.isArray(preferences[key])) throw new Error(`${key} must be an array`);
  }
  for (const server of (preferences["servers.list"] ?? []) as unknown[]) {
    if (!object(server) || typeof server.id !== "string" || !server.id || typeof server.name !== "string" || !object(server.auth) ||
      !(server.auth.kind === "agent" || (server.auth.kind === "key" && typeof server.auth.keyPath === "string" && typeof server.auth.dedicated === "boolean")) ||
      !decodeCommand(JSON.stringify({ ...server, type: "servers.add", requestId: "settings", keyPath: server.auth.kind === "key" ? server.auth.keyPath : undefined, useAgent: server.auth.kind === "agent" }))) {
      throw new Error("servers.list contains an invalid server");
    }
  }
  for (const group of (preferences["servers.groups"] ?? []) as unknown[]) {
    if (!object(group) || typeof group.id !== "string" || !group.id || typeof group.name !== "string") throw new Error("servers.groups contains an invalid group");
  }
  for (const [key, value] of Object.entries(preferences)) {
    if (key.startsWith("skills.builtin.") && (!object(value) || (value.enabled !== undefined && typeof value.enabled !== "boolean"))) throw new Error(`${key} must have a boolean enabled setting`);
  }
}
