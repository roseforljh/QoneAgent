import type { Db } from "@qone/database";

/** Move unified-store configuration into its domain stores, without path fallbacks. */
export function moveDomainData(runtime: Db, config: Db, mcp: Db): void {
  const models = runtime.$client.query("SELECT * FROM model_configs").all() as {
    id: string; provider: string; model: string; config: string; enabled: number; updated_at: number;
  }[];
  const permissions = runtime.$client.query("SELECT * FROM permission_rules").all() as {
    subject_id: string; permission: string; decision: string; updated_at: number;
  }[];
  const preferences = runtime.$client.query("SELECT * FROM settings WHERE key IN (?, ?)").all("compaction.settings", "subagents.config") as {
    key: string; value: string; updated_at: number;
  }[];
  const servers = runtime.$client.query("SELECT * FROM mcp_servers").all() as {
    id: string; name: string; config: string; enabled: number; updated_at: number;
  }[];
  if (!models.length && !permissions.length && !preferences.length && !servers.length) return;

  // Destination copies commit before source deletion. A failed/interrupted move
  // is safe to retry; updated_at prevents a stale copy replacing newer settings.
  config.$client.transaction(() => {
    const insertModel = config.$client.query(`INSERT INTO model_configs (id, provider, model, config, enabled, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET provider=excluded.provider, model=excluded.model, config=excluded.config,
      enabled=excluded.enabled, updated_at=excluded.updated_at WHERE excluded.updated_at > model_configs.updated_at`);
    for (const row of models) insertModel.run(row.id, row.provider, row.model, row.config, row.enabled, row.updated_at);
    const insertPermission = config.$client.query(`INSERT INTO permission_rules (subject_id, permission, decision, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(subject_id, permission) DO UPDATE SET decision=excluded.decision, updated_at=excluded.updated_at
      WHERE excluded.updated_at > permission_rules.updated_at`);
    for (const row of permissions) insertPermission.run(row.subject_id, row.permission, row.decision, row.updated_at);
    const insertPreference = config.$client.query(`INSERT INTO settings (key, value, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value, updated_at=excluded.updated_at WHERE excluded.updated_at > settings.updated_at`);
    for (const row of preferences) insertPreference.run(row.key, row.value, row.updated_at);
  })();
  mcp.$client.transaction(() => {
    const insert = mcp.$client.query(`INSERT INTO mcp_servers (id, name, config, enabled, updated_at) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET name=excluded.name, config=excluded.config, enabled=excluded.enabled,
      updated_at=excluded.updated_at WHERE excluded.updated_at > mcp_servers.updated_at`);
    for (const row of servers) insert.run(row.id, row.name, row.config, row.enabled, row.updated_at);
  })();
  runtime.$client.transaction(() => {
    for (const row of models) runtime.$client.query("DELETE FROM model_configs WHERE id=? AND updated_at=? AND provider=? AND model=? AND config=? AND enabled=?").run(row.id, row.updated_at, row.provider, row.model, row.config, row.enabled);
    for (const row of permissions) runtime.$client.query("DELETE FROM permission_rules WHERE subject_id=? AND permission=? AND updated_at=? AND decision=?").run(row.subject_id, row.permission, row.updated_at, row.decision);
    for (const row of preferences) runtime.$client.query("DELETE FROM settings WHERE key=? AND updated_at=? AND value=?").run(row.key, row.updated_at, row.value);
    for (const row of servers) runtime.$client.query("DELETE FROM mcp_servers WHERE id=? AND updated_at=? AND name=? AND config=? AND enabled=?").run(row.id, row.updated_at, row.name, row.config, row.enabled);
  })();
}
