import { readdir, readFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { PluginManifest, type PluginContext, type PluginSetupFn, type PluginToolDefinition } from "@qone/plugin-sdk";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createLogger } from "@qone/shared";
import type { PermissionDecision, PermissionRuleStore } from "./permissions.js";

const log = createLogger("plugin-runtime");

export interface LoadedPlugin {
  manifest: PluginManifest;
  tools: ToolDefinition[];
  skills: PluginSkillRegistration[];
  hooks: { event: string; handler: (payload: unknown) => void | Promise<void> }[];
  shutdown: (() => void | Promise<void>)[];
}

export interface DiscoveredPlugin {
  manifest: PluginManifest;
  dir: string;
  entryPath: string;
}

export interface PluginSkillRegistration {
  pluginId: string;
  name: string;
  description?: string;
  content: string;
}

export async function discoverPlugins(pluginsDir: string): Promise<DiscoveredPlugin[]> {
  if (!existsSync(pluginsDir)) return [];
  const discovered: DiscoveredPlugin[] = [];
  const ids = new Set<string>();
  for (const entry of await readdir(pluginsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(pluginsDir, entry.name);
    const manifestPath = path.join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue;
    try {
      const manifest = PluginManifest.parse(JSON.parse(await readFile(manifestPath, "utf8")));
      if (ids.has(manifest.id)) throw new Error(`duplicate plugin id: ${manifest.id}`);
      const pluginRoot = path.resolve(dir);
      const entryPath = path.resolve(pluginRoot, manifest.entry);
      if (entryPath !== pluginRoot && !entryPath.startsWith(`${pluginRoot}${path.sep}`)) throw new Error("plugin entry escapes plugin directory");
      if (!existsSync(entryPath)) throw new Error("plugin entry missing");
      ids.add(manifest.id);
      discovered.push({ manifest, dir, entryPath });
    } catch (error) {
      log.error("plugin manifest rejected", { dir, err: String(error) });
    }
  }
  return discovered;
}

export async function loadPlugins(
  pluginsDir: string,
  opts: { permissionRules?: PermissionRuleStore; discovered?: DiscoveredPlugin[] } = {},
): Promise<LoadedPlugin[]> {
  const out: LoadedPlugin[] = [];
  for (const plugin of opts.discovered ?? await discoverPlugins(pluginsDir)) {
    const { manifest, dir, entryPath } = plugin;
    if (opts.permissionRules?.get(`plugin:${manifest.id}`, "plugin.load") !== "allow") continue;
    try {
      const tools: ToolDefinition[] = [];
      const skills: PluginSkillRegistration[] = [];
      const hooks: { event: string; handler: (payload: unknown) => void | Promise<void> }[] = [];
      const shutdown: (() => void | Promise<void>)[] = [];
      const listeners = new Map<string, Set<(payload: unknown) => void | Promise<void>>>();
      const storageDir = path.join(dir, ".storage");
      const storageFile = path.join(storageDir, "kv.json");

      const ctx: PluginContext = {
        manifest,
        tools: {
          register: (definition) => {
            const requested = definition.permissions ?? manifest.permissions;
            const undeclared = requested.filter((permission) => !manifest.permissions.includes(permission));
            if (undeclared.length) throw new Error(`plugin tool requests undeclared permissions: ${undeclared.join(", ")}`);
            const { permissions: _permissions, ...tool } = definition as PluginToolDefinition;
            tools.push({ ...tool, name: `plugin:${manifest.id}:${tool.name}`, qonePermissions: [...new Set(requested)] } as ToolDefinition);
          },
        },
        skills: { register: (skill) => skills.push({ ...skill, pluginId: manifest.id }) },
        storage: {
          async get(key) {
            if (!existsSync(storageFile)) return null;
            const data = JSON.parse(await readFile(storageFile, "utf8"));
            return data[key] ?? null;
          },
          async set(key, value) {
            await mkdir(storageDir, { recursive: true });
            const data = existsSync(storageFile) ? JSON.parse(await readFile(storageFile, "utf8")) : {};
            data[key] = value;
            await Bun.write(storageFile, JSON.stringify(data, null, 2));
          },
          async delete(key) {
            if (!existsSync(storageFile)) return;
            const data = JSON.parse(await readFile(storageFile, "utf8"));
            delete data[key];
            await Bun.write(storageFile, JSON.stringify(data, null, 2));
          },
        },
        permissions: {
          declared: (permission) => manifest.permissions.includes(permission),
          request: async (permission) => {
            if (!manifest.permissions.includes(permission)) return false;
            const decision = opts.permissionRules?.get(`plugin:${manifest.id}`, permission) as PermissionDecision | undefined;
            return decision === "allow";
          },
        },
        events: {
          on(event, handler) {
            const set = listeners.get(event) ?? new Set();
            set.add(handler);
            listeners.set(event, set);
            return () => set.delete(handler);
          },
          async emit(event, payload) {
            for (const handler of listeners.get(event) ?? []) await handler(payload);
          },
        },
        hooks: { register: (event, handler) => hooks.push({ event, handler }) },
        lifecycle: { onShutdown: (handler) => shutdown.push(handler) },
        logger: {
          info: (message) => log.info(message, { plugin: manifest.id }),
          warn: (message) => log.warn(message, { plugin: manifest.id }),
          error: (message) => log.error(message, { plugin: manifest.id }),
        },
      };

      const mod = (await import(entryPath)) as { default?: PluginSetupFn };
      if (typeof mod.default !== "function") throw new Error("plugin has no default setup export");
      await mod.default(ctx);
      out.push({ manifest, tools, skills, hooks, shutdown });
      log.info("plugin loaded", { plugin: manifest.id, tools: tools.length });
    } catch (error) {
      log.error("plugin load failed", { dir, err: String(error) });
    }
  }
  return out;
}
