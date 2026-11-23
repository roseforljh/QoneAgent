import { existsSync, mkdirSync, readFileSync, renameSync, watch, writeFileSync, type FSWatcher } from "node:fs";
import path from "node:path";
import type { McpServerInfo, PermissionDecision } from "@qone/protocol";

type Json = Record<string, unknown>;
const isObject = (value: unknown): value is Json => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * A human- and agent-editable JSON file, like pi's or Claude Code's settings.json.
 * Writes are atomic; edits made by anyone else are reloaded and reported to `onExternalChange`.
 */
export class ConfigFile {
  private data: Json = {};
  private lastText = "";
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private listeners = new Set<(previous: Json, next: Json) => void>();
  private invalidListeners = new Set<(error: Error) => void>();
  /** Set while the file on disk cannot be parsed; writes wait so the broken edit is never overwritten. */
  error?: Error;

  constructor(
    readonly file: string,
    private validate: (data: Json) => void = () => {},
    private options: { compact?: boolean; reloadBeforeWrite?: boolean } = {},
  ) {
    try { this.load(); }
    catch (error) { this.error = error instanceof Error ? error : new Error(String(error)); }
  }

  private load() {
    if (!existsSync(this.file)) return;
    const text = readFileSync(this.file, "utf8");
    let parsed: unknown;
    try { parsed = JSON.parse(text); }
    catch { throw new Error("Invalid JSON; finish or fix the edit before saving"); }
    if (!isObject(parsed)) throw new Error("The file must contain a JSON object");
    this.validate(parsed);
    this.data = parsed; this.lastText = text;
  }

  snapshot(): Json { return structuredClone(this.data); }
  read<T = unknown>(section: string): T | undefined { return structuredClone(this.data[section]) as T | undefined; }
  /** 仅克隆单个键，避免读取大缓存文件（如 state.json）时整段深拷贝数 MB 对象。 */
  readKey<T = unknown>(section: string, key: string): T | undefined {
    const entries = this.data[section];
    return isObject(entries) ? structuredClone(entries[key]) as T | undefined : undefined;
  }

  /** Reload first so a local save cannot overwrite an external edit waiting for the watcher. */
  update<T>(section: string, change: (current: T | undefined) => unknown) {
    if (this.options.reloadBeforeWrite !== false) this.reload();
    if (this.error) throw new Error(`${path.basename(this.file)} has a syntax error or invalid setting; fix it before saving: ${this.error.message}`);
    const next = { ...this.data };
    const value = change(this.read<T>(section));
    if (value === undefined) delete next[section]; else next[section] = structuredClone(value);
    this.save(next);
  }

  /** 仅更新 section 中的单个键，避免对整个 section 执行两次 structuredClone。 */
  setKey(section: string, key: string, value: unknown) {
    if (this.options.reloadBeforeWrite !== false) this.reload();
    if (this.error) throw new Error(`${path.basename(this.file)} has a syntax error or invalid setting; fix it before saving: ${this.error.message}`);
    const current = isObject(this.data[section]) ? this.data[section] as Json : {};
    const nextSection: Json = { ...current, [key]: structuredClone(value) };
    this.save({ ...this.data, [section]: nextSection });
  }

  deleteKey(section: string, key: string) {
    if (this.options.reloadBeforeWrite !== false) this.reload();
    if (this.error) throw new Error(`${path.basename(this.file)} has a syntax error or invalid setting; fix it before saving: ${this.error.message}`);
    const current = isObject(this.data[section]) ? this.data[section] as Json : {};
    if (!(key in current)) return;
    const { [key]: _removed, ...rest } = current;
    this.save({ ...this.data, [section]: rest });
  }

  /** Atomic replace of one top-level section, leaving every other key as written. */
  write(section: string, value: unknown) { this.update(section, () => value); }

  private save(next: Json) {
    const text = this.options.compact ? `${JSON.stringify(next)}\n` : `${JSON.stringify(next, null, 2)}\n`;
    if (text === this.lastText && existsSync(this.file)) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const staging = `${this.file}.${process.pid}.tmp`;
    writeFileSync(staging, text);
    renameSync(staging, this.file);
    this.data = next; this.lastText = text;
  }

  onExternalChange(listener: (previous: Json, next: Json) => void) { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onInvalid(listener: (error: Error) => void) { this.invalidListeners.add(listener); return () => this.invalidListeners.delete(listener); }

  /** Watches the directory so editors that replace the file (rename-on-save) are seen too. */
  watch() {
    if (this.watcher) return;
    const report = (error: unknown) => {
      const failure = error instanceof Error ? error : new Error(String(error));
      for (const listener of this.invalidListeners) listener(failure);
    };
    try {
      const directory = path.dirname(this.file);
      mkdirSync(directory, { recursive: true });
      this.watcher = watch(directory, (_event, name) => {
        if (name && path.basename(String(name)) !== path.basename(this.file)) return;
        clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          try { this.reload(); }
          catch (error) { report(error); }
        }, 150);
      }).on("error", (error) => { this.close(); report(error); });
    } catch (error) { report(error); }
  }

  /**
   * Re-reads the file. An invalid file keeps the last good state (and blocks writes until fixed);
   * a deleted file is restored from memory instead of being read as "remove everything".
   */
  reload() {
    if (!existsSync(this.file)) {
      if (this.error || !Object.keys(this.data).length) return;
      this.save(this.data);
      return;
    }
    let text: string;
    try { text = readFileSync(this.file, "utf8"); } catch { return; }
    if (text === this.lastText) return;
    const previous = this.data;
    try { this.load(); this.error = undefined; }
    catch (error) {
      this.lastText = text;
      this.error = error instanceof Error ? error : new Error(String(error));
      for (const listener of this.invalidListeners) listener(this.error);
      return;
    }
    for (const listener of this.listeners) listener(previous, this.data);
  }

  close() { clearTimeout(this.timer); this.watcher?.close(); this.watcher = undefined; }
}

/** What preference consumers need; both the file section and the runtime SQLite store satisfy it. */
export interface PreferenceStore {
  readonly error?: Error;
  get<T = unknown>(key: string): T | undefined;
  set(key: string, value: unknown): void;
}

/** Key-value preferences stored as one object section of a config file. */
export class PreferencesRepo implements PreferenceStore {
  constructor(private file: ConfigFile, private section = "preferences") {}
  get error() { return this.file.error; }
  get<T = unknown>(key: string): T | undefined { return this.file.readKey<T>(this.section, key); }
  set(key: string, value: unknown) { this.file.setKey(this.section, key, value); }
  delete(key: string) { this.file.deleteKey(this.section, key); }
}

/** `mcpServers` keyed by server id, in Claude Code's shape: `type` instead of `transport`. */
export class McpServerRepo {
  constructor(private file: ConfigFile) {}
  private entries() { return this.file.read<Record<string, Json>>("mcpServers") ?? {}; }

  upsert(config: McpServerInfo) {
    // Configuration keeps only `$` references; secret values live in the encrypted store.
    const { id, connected: _connected, available: _available, connecting: _connecting, toolCount: _toolCount, transport, ...rest } = config;
    const entry: Json = { ...rest,
      ...(transport ? { type: transport } : {}),
      ...(config.env ? { env: Object.fromEntries(Object.entries(config.env).filter(([, value]) => value.startsWith("$"))) } : {}),
      ...(config.headers ? { headers: Object.fromEntries(Object.entries(config.headers).filter(([, value]) => value.startsWith("$mcp.env:") || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value))) } : {}),
    };
    for (const key of Object.keys(entry)) if (entry[key] === undefined) delete entry[key];
    this.file.update<Json>("mcpServers", entries => ({ ...entries, [id]: entry }));
    return { id, name: config.name, config: JSON.stringify(entry), enabled: true, updatedAt: Date.now() };
  }

  list(): McpServerInfo[] {
    return mcpServersFrom(this.entries()).map(server => ({ ...server,
      ...(server.env ? { env: Object.fromEntries(Object.entries(server.env).filter(([, value]) => value.startsWith("$"))) } : {}),
      ...(server.headers ? { headers: Object.fromEntries(Object.entries(server.headers).filter(([, value]) => value.startsWith("$mcp.env:") || /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(value))) } : {}),
    }));
  }

  delete(id: string) { this.file.update<Json>("mcpServers", entries => { const { [id]: _removed, ...rest } = entries ?? {}; return rest; }); }
}

/** Reads a `mcpServers` section into configurations, skipping entries that are not objects. */
export function mcpServersFrom(entries: unknown): McpServerInfo[] {
  if (!isObject(entries)) return [];
  return Object.entries(entries).flatMap(([id, raw]) => {
    if (!isObject(raw)) return [];
    const { type, ...rest } = raw;
    return [{ ...rest, id, name: typeof raw.name === "string" ? raw.name : id, ...(type === "http" || type === "sse" ? { transport: type } : {}) } as McpServerInfo];
  });
}

/** `models` keyed by id; the first entry is the most recently saved, as the database ordered them. */
export class ModelConfigRepo {
  constructor(private file: ConfigFile) {}
  private entries() { return this.file.read<Record<string, Json>>("models") ?? {}; }

  list() {
    return Object.entries(this.entries()).flatMap(([id, raw]) => {
      if (!isObject(raw) || typeof raw.provider !== "string" || typeof raw.model !== "string") return [];
      const { provider, model, enabled, ...config } = raw;
      return [{ id, provider, model, config, enabled: enabled !== false, updatedAt: 0 }];
    });
  }

  upsert(config: { id?: string; provider: string; model: string; config?: Record<string, unknown>; enabled?: boolean }) {
    const id = config.id ?? `${config.provider}/${config.model}`;
    this.file.update<Json>("models", entries => {
      const { [id]: _previous, ...rest } = entries ?? {};
      return { [id]: { provider: config.provider, model: config.model, ...config.config, ...(config.enabled === false ? { enabled: false } : {}) }, ...rest };
    });
    return { id, provider: config.provider, model: config.model, config: config.config ?? {}, enabled: config.enabled !== false, updatedAt: Date.now() };
  }

  delete(id: string) { this.file.update<Json>("models", entries => { const { [id]: _removed, ...rest } = entries ?? {}; return rest; }); }
}

/** `permissions` as `{ subject: { permission: decision } }`. */
export class PermissionRepo {
  constructor(private file: ConfigFile) {}
  private entries() { return this.file.read<Record<string, Record<string, PermissionDecision>>>("permissions") ?? {}; }

  list() {
    return Object.entries(this.entries()).sort(([a], [b]) => a.localeCompare(b)).flatMap(([subjectId, rules]) => isObject(rules)
      ? Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)).map(([permission, decision]) => ({ subjectId, permission, decision: String(decision), updatedAt: 0 }))
      : []);
  }

  get(subjectId: string, permission: string): PermissionDecision | undefined {
    const decision = this.entries()[subjectId]?.[permission];
    return decision === "allow" || decision === "ask" || decision === "deny" ? decision : undefined;
  }

  set(subjectId: string, permission: string, decision: PermissionDecision) {
    this.file.update<Record<string, Record<string, PermissionDecision>>>("permissions", entries => ({ ...entries, [subjectId]: { ...entries?.[subjectId], [permission]: decision } }));
    return { subjectId, permission, decision, updatedAt: Date.now() };
  }

  ensure(subjectId: string, permission: string, decision: PermissionDecision) {
    if (!this.file.error && this.get(subjectId, permission) === undefined) return this.set(subjectId, permission, decision);
    return undefined;
  }
}
