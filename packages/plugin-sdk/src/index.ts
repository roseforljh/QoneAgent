import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

export const PluginManifest = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/i),
  name: z.string().min(1).max(100),
  version: z.string().min(1).max(50),
  description: z.string().max(500).optional(),
  entry: z.string().min(1).default("index.ts"),
  permissions: z.array(z.string().min(1)).max(32).default([]),
});
export type PluginManifest = z.infer<typeof PluginManifest>;

export type PluginToolDefinition = ToolDefinition & { permissions?: string[] };

export interface PluginToolAPI {
  register(tool: PluginToolDefinition): void;
}

export interface PluginSkill {
  name: string;
  description?: string;
  content: string;
}

export interface PluginSkillAPI {
  register(skill: PluginSkill): void;
}

export interface PluginPermissionAPI {
  request(permission: string, reason?: string): Promise<boolean>;
  declared(permission: string): boolean;
}

export interface PluginEventAPI {
  on(event: string, handler: (payload: unknown) => void | Promise<void>): () => void;
  emit(event: string, payload?: unknown): Promise<void>;
}

export interface PluginHookAPI {
  register(event: "beforeRun" | "afterRun" | "shutdown", handler: (payload: unknown) => void | Promise<void>): void;
}

export interface PluginStorage {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
  delete(key: string): Promise<void>;
}

export interface PluginContext {
  manifest: PluginManifest;
  tools: PluginToolAPI;
  skills: PluginSkillAPI;
  storage: PluginStorage;
  permissions: PluginPermissionAPI;
  events: PluginEventAPI;
  hooks: PluginHookAPI;
  lifecycle: { onShutdown(handler: () => void | Promise<void>): void };
  logger: {
    info(msg: string): void;
    warn(msg: string): void;
    error(msg: string): void;
  };
}

export type PluginSetupFn = (ctx: PluginContext) => void | Promise<void>;
