import { Database } from "bun:sqlite";
import { drizzle } from "drizzle-orm/bun-sqlite";
import * as schema from "./schema.js";

export * from "./repos.js";
export {
  sessions,
  messages,
  runs,
  subagentRuns,
  subagentMessages,
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
  goals,
  goalEvents,
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
      parts TEXT,
      attachments TEXT,
      model TEXT,
      goal_id TEXT,
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
      error TEXT,
      origin TEXT NOT NULL DEFAULT 'manual',
      goal_id TEXT,
      goal_epoch INTEGER
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
      run_id TEXT,
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

    CREATE TABLE IF NOT EXISTS goals (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      objective TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      waiting_reason TEXT,
      waiting_until INTEGER,
      stop_reason TEXT,
      run_options TEXT,
      epoch INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goals_session ON goals(session_id);

    CREATE TABLE IF NOT EXISTS goal_events (
      id TEXT PRIMARY KEY,
      goal_id TEXT NOT NULL REFERENCES goals(id) ON DELETE CASCADE,
      session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      run_id TEXT,
      type TEXT NOT NULL,
      payload TEXT NOT NULL DEFAULT '{}',
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_goal_events_goal ON goal_events(goal_id, created_at);
  `);
  const messageColumns = new Set(sqlite.query("PRAGMA table_info(messages)").all().map((column) => (column as { name: string }).name));
  if (!sqlite.query("PRAGMA table_info(artifacts)").all().some((column) => (column as { name: string }).name === "run_id")) {
    sqlite.exec("ALTER TABLE artifacts ADD COLUMN run_id TEXT");
  }
  if (!messageColumns.has("goal_id")) sqlite.exec("ALTER TABLE messages ADD COLUMN goal_id TEXT");
  const runColumns = new Set(sqlite.query("PRAGMA table_info(runs)").all().map((column) => (column as { name: string }).name));
  if (!runColumns.has("origin")) sqlite.exec("ALTER TABLE runs ADD COLUMN origin TEXT NOT NULL DEFAULT 'manual'");
  if (!runColumns.has("goal_id")) sqlite.exec("ALTER TABLE runs ADD COLUMN goal_id TEXT");
  if (!runColumns.has("goal_epoch")) sqlite.exec("ALTER TABLE runs ADD COLUMN goal_epoch INTEGER");
  const goalColumns = new Set(sqlite.query("PRAGMA table_info(goals)").all().map((column) => (column as { name: string }).name));
  if (!goalColumns.has("run_options")) sqlite.exec("ALTER TABLE goals ADD COLUMN run_options TEXT");
  if (!sqlite.query("PRAGMA table_info(messages)").all().some((column) => (column as { name: string }).name === "attachments")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN attachments TEXT");
  }
  if (!sqlite.query("PRAGMA table_info(messages)").all().some((column) => (column as { name: string }).name === "parts")) {
    sqlite.exec("ALTER TABLE messages ADD COLUMN parts TEXT");
  }
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS subagent_runs (
      run_id TEXT PRIMARY KEY REFERENCES runs(id) ON DELETE CASCADE,
      parent_session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
      parent_run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
      parent_subagent_id TEXT,
      depth INTEGER NOT NULL DEFAULT 0,
      tool_call_id TEXT NOT NULL,
      execution_session_id TEXT,
      profile_id TEXT,
      title TEXT NOT NULL,
      task TEXT NOT NULL,
      model TEXT,
      permission_mode TEXT,
      tools TEXT,
      content TEXT NOT NULL DEFAULT '',
      parts TEXT NOT NULL DEFAULT '[]',
      turn_count INTEGER NOT NULL DEFAULT 1,
      retry_count INTEGER NOT NULL DEFAULT 0,
      workflow_id TEXT,
      workflow_step_id TEXT,
      depends_on TEXT,
      context_mode TEXT NOT NULL DEFAULT 'snapshot',
      context_message_count INTEGER NOT NULL DEFAULT 0,
      token_usage TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_runs_parent ON subagent_runs(parent_session_id, parent_run_id);
    CREATE TABLE IF NOT EXISTS subagent_messages (
      id TEXT PRIMARY KEY,
      subagent_run_id TEXT NOT NULL REFERENCES subagent_runs(run_id) ON DELETE CASCADE,
      sequence INTEGER NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      parts TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_subagent_messages_run ON subagent_messages(subagent_run_id, sequence);
  `);
  const subagentColumns = new Set(sqlite.query("PRAGMA table_info(subagent_runs)").all().map((column) => (column as { name: string }).name));
  const additions: [string, string][] = [
    ["parent_subagent_id", "TEXT"], ["depth", "INTEGER NOT NULL DEFAULT 0"],
    ["execution_session_id", "TEXT"], ["profile_id", "TEXT"], ["turn_count", "INTEGER NOT NULL DEFAULT 1"],
    ["retry_count", "INTEGER NOT NULL DEFAULT 0"], ["workflow_id", "TEXT"],
    ["workflow_step_id", "TEXT"], ["depends_on", "TEXT"],
    ["permission_mode", "TEXT"], ["tools", "TEXT"],
    ["context_mode", "TEXT NOT NULL DEFAULT 'snapshot'"],
    ["context_message_count", "INTEGER NOT NULL DEFAULT 0"], ["token_usage", "TEXT"],
  ];
  for (const [name, definition] of additions) if (!subagentColumns.has(name)) sqlite.exec(`ALTER TABLE subagent_runs ADD COLUMN ${name} ${definition}`);
  if (!sqlite.query("PRAGMA table_info(subagent_messages)").all().some((column) => (column as { name: string }).name === "raw_message")) sqlite.exec("ALTER TABLE subagent_messages ADD COLUMN raw_message TEXT");
}
