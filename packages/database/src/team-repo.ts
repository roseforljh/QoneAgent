import type { TeamBot, TeamGroup, TeamMessage, TeamRunCard } from "@qone/protocol";
import type { Db } from "./index.js";
import type { SqliteClient } from "./sqlite-client.js";

/** 团队模式表的幂等建表；实体以协议 JSON 整体存储，检索字段单独成列。 */
export function migrateTeamTables(sqlite: SqliteClient) {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS team_bots (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_groups (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_messages (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
      data TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_messages_group ON team_messages(group_id, created_at);
    CREATE TABLE IF NOT EXISTS team_runs (
      id TEXT PRIMARY KEY,
      group_id TEXT NOT NULL REFERENCES team_groups(id) ON DELETE CASCADE,
      status TEXT NOT NULL,
      data TEXT NOT NULL,
      started_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_team_runs_group ON team_runs(group_id, started_at);
  `);
}

const parse = <T>(rows: unknown[]): T[] => (rows as { data: string }[]).map((row) => JSON.parse(row.data) as T);

/** 团队机器人、群聊、消息与运行卡片的 SQLite 仓库。运行记录允许携带编排器内部字段。 */
export class TeamRepo {
  constructor(private db: Db) {}

  private get sql() { return this.db.$client; }

  /** 四张表都没有记录时才允许导入旧版本地数据。 */
  isEmpty(): boolean {
    return ["team_bots", "team_groups", "team_messages", "team_runs"]
      .every((table) => !this.sql.prepare(`SELECT 1 FROM ${table} LIMIT 1`).get());
  }

  transaction<T>(write: () => T): T {
    return this.sql.transaction(write).immediate();
  }

  listBots(): TeamBot[] {
    return parse<TeamBot>(this.sql.prepare("SELECT data FROM team_bots ORDER BY created_at, id").all());
  }

  getBot(id: string): TeamBot | undefined {
    const row = this.sql.prepare("SELECT data FROM team_bots WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as TeamBot : undefined;
  }

  saveBot(bot: TeamBot) {
    this.sql.prepare(`INSERT INTO team_bots (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(bot.id, JSON.stringify(bot), bot.createdAt, bot.updatedAt);
  }

  deleteBot(id: string) {
    this.sql.prepare("DELETE FROM team_bots WHERE id = ?").run(id);
  }

  listGroups(): TeamGroup[] {
    return parse<TeamGroup>(this.sql.prepare("SELECT data FROM team_groups ORDER BY updated_at DESC, id").all());
  }

  getGroup(id: string): TeamGroup | undefined {
    const row = this.sql.prepare("SELECT data FROM team_groups WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as TeamGroup : undefined;
  }

  saveGroup(group: TeamGroup) {
    this.sql.prepare(`INSERT INTO team_groups (id, data, created_at, updated_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`)
      .run(group.id, JSON.stringify(group), group.createdAt, group.updatedAt);
  }

  /** 消息与运行记录随外键级联删除。 */
  deleteGroup(id: string) {
    this.sql.prepare("DELETE FROM team_groups WHERE id = ?").run(id);
  }

  /** 每个群返回最近 limit 条消息，按时间正序。 */
  listMessages(limit: number, groupId?: string): TeamMessage[] {
    const rows = this.sql.prepare(`SELECT data FROM (
        SELECT data, created_at, rowid AS seq, ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY created_at DESC, rowid DESC) AS rank
        FROM team_messages ${groupId ? "WHERE group_id = ?" : ""}
      ) WHERE rank <= ? ORDER BY created_at, seq`).all(...(groupId ? [groupId, limit] : [limit]));
    return parse<TeamMessage>(rows);
  }

  getMessage(id: string): TeamMessage | undefined {
    const row = this.sql.prepare("SELECT data FROM team_messages WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as TeamMessage : undefined;
  }

  saveMessage(message: TeamMessage) {
    this.sql.prepare(`INSERT INTO team_messages (id, group_id, data, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data = excluded.data`)
      .run(message.id, message.groupId, JSON.stringify(message), message.createdAt);
  }

  /** 每个群返回最近 limit 个运行记录，按开始时间正序。 */
  listRuns<T extends TeamRunCard = TeamRunCard>(limit: number): T[] {
    return parse<T>(this.sql.prepare(`SELECT data FROM (
        SELECT data, started_at, ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY started_at DESC) AS rank FROM team_runs
      ) WHERE rank <= ? ORDER BY started_at`).all(limit));
  }

  listRunsByStatus<T extends TeamRunCard = TeamRunCard>(statuses: readonly string[]): T[] {
    if (!statuses.length) return [];
    return parse<T>(this.sql.prepare(`SELECT data FROM team_runs WHERE status IN (${statuses.map(() => "?").join(", ")}) ORDER BY started_at`).all(...statuses));
  }

  getRun<T extends TeamRunCard = TeamRunCard>(id: string): T | undefined {
    const row = this.sql.prepare("SELECT data FROM team_runs WHERE id = ?").get(id) as { data: string } | undefined;
    return row ? JSON.parse(row.data) as T : undefined;
  }

  saveRun(run: TeamRunCard) {
    this.sql.prepare(`INSERT INTO team_runs (id, group_id, status, data, started_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, updated_at = excluded.updated_at`)
      .run(run.id, run.groupId, run.status, JSON.stringify(run), run.startedAt, run.updatedAt);
  }

  /** 清空群聊记录：删除该群全部消息与运行卡片，保留群配置。 */
  clearGroup(groupId: string) {
    this.transaction(() => {
      this.sql.prepare("DELETE FROM team_messages WHERE group_id = ?").run(groupId);
      this.sql.prepare("DELETE FROM team_runs WHERE group_id = ?").run(groupId);
    });
  }
}
