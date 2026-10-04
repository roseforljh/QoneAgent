export const CONFIG_SCHEMA = `
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE IF NOT EXISTS permission_rules (
      subject_id TEXT NOT NULL,
      permission TEXT NOT NULL,
      decision TEXT NOT NULL DEFAULT 'ask',
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (subject_id, permission)
    );
    CREATE INDEX IF NOT EXISTS idx_permission_rules_subject ON permission_rules(subject_id);

    CREATE TABLE IF NOT EXISTS model_configs (
      id TEXT PRIMARY KEY,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
`;

export const MCP_SCHEMA = `
    CREATE TABLE IF NOT EXISTS mcp_servers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      config TEXT NOT NULL,
      enabled INTEGER NOT NULL DEFAULT 1,
      updated_at INTEGER NOT NULL
    );
`;
