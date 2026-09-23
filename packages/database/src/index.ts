import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

export * from "./repos.js";
export {
  sessions,
  messages,
  runs,
  turns,
  toolCalls,
  workspaces,
  artifacts,
  plugins,
  pluginPermissions,
  permissionRules,
  mcpServers,
  skills,
  settings,
  modelConfigs,
  events,
} from "./schema.js";

export type Db = ReturnType<typeof openDb>;

export interface SqliteDriver {
  open(path: string): Database;
}

/** Default Bun driver. A Node sqlite driver can be supplied without changing
 * repositories if the Runtime compatibility gate ever selects Node. */
export const bunSqliteDriver: SqliteDriver = {
  open: (path) => new Database(path, { create: true }),
};

export function openDb(path: string, driver: SqliteDriver = bunSqliteDriver) {
  const dir = path.replace(/[/\\][^/\\]+$/, "");
  if (dir && dir !== path) {
    const fs = require("node:fs");
    fs.mkdirSync(dir, { recursive: true });
  }
  const sqlite = driver.open(path);
  sqlite.exec("PRAGMA journal_mode = WAL;");
  sqlite.exec("PRAGMA synchronous = NORMAL;");
  sqlite.exec("PRAGMA foreign_keys = ON;");
  sqlite.exec("PRAGMA busy_timeout = 5000;");
  migrate(sqlite);
  return drizzle(sqlite, { schema });
}

export function closeDb(db: Db) {
  db.$client.close();
}

// Bootstrap migration mirrors drizzle/0000_initial.sql plus later schema changes.
// Keeping this small fallback makes first launch self-contained.
function migrate(sqlite: Database) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL DEFAULT 'New session',
      workspace_id TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sessions_workspace ON sessions(workspace_id);

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      attachments TEXT,
      model TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id);

    CREATE TABLE IF NOT EXISTS runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      status TEXT NOT NULL DEFAULT 'created',
      started_at INTEGER,
      completed_at INTEGER,
      error TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_runs_session ON runs(session_id);

    CREATE TABLE IF NOT EXISTS tool_calls (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      tool_name TEXT NOT NULL,
      arguments TEXT,
      result_summary TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
      started_at INTEGER,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_tool_calls_run ON tool_calls(run_id);

    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      name TEXT NOT NULL,
      path TEXT NOT NULL,
      mime_type TEXT,
      size INTEGER,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_session ON artifacts(session_id);

    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'running',
      started_at INTEGER NOT NULL,
      completed_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_turns_run ON turns(run_id);

    CREATE TABLE IF NOT EXISTS plugins (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      version TEXT NOT NULL,
      manifest TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS plugin_permissions (
      plugin_id TEXT NOT NULL REFERENCES plugins(id) ON DELETE CASCADE,
      permission TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'ask',
      PRIMARY KEY (plugin_id, permission)
    );
    CREATE INDEX IF NOT EXISTS idx_plugin_permissions_plugin ON plugin_permissions(plugin_id);

    CREATE TABLE IF NOT EXISTS permission_rules (
      subject_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'ask',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject_id, permission)
    );
    CREATE INDEX IF NOT EXISTS idx_permission_rules_subject ON permission_rules(subject_id);

    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS skills (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      description TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS model_configs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT PRIMARY KEY,
      session_id TEXT,
      run_id TEXT,
      sequence INTEGER NOT NULL UNIQUE,
      type TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      payload TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_session_sequence ON events(session_id, sequence);
  `);
  if (!sqlite.query("PRAGMA table_info(messages)").all().some((column) => (column as { name: string }).name === "attachments")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  }
}
