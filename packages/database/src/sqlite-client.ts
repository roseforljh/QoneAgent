import { DatabaseSync, type SQLInputValue, type StatementSync } from "node:sqlite";
import { BetterSQLiteSession } from "drizzle-orm/better-sqlite3/session";
import { BaseSQLiteDatabase, SQLiteSyncDialect } from "drizzle-orm/sqlite-core";
import { createTableRelationsHelpers, extractTablesRelationalConfig } from "drizzle-orm/relations";

/** better-sqlite3's statement surface, which drizzle's sync driver calls. */
export class SqliteStatement {
  constructor(private readonly statement: StatementSync, private readonly arrays = false) {}
  run(...params: SQLInputValue[]) { return this.statement.run(...params); }
  // Drizzle reuses one prepared statement for object rows and raw array rows.
  all(...params: SQLInputValue[]) { this.statement.setReturnArrays(this.arrays); return this.statement.all(...params); }
  get(...params: SQLInputValue[]) { this.statement.setReturnArrays(this.arrays); return this.statement.get(...params); }
  iterate(...params: SQLInputValue[]) { this.statement.setReturnArrays(this.arrays); return this.statement.iterate(...params); }
  raw() { return new SqliteStatement(this.statement, true); }
}

type Transaction<T extends unknown[], R> = ((...args: T) => R) & Record<"deferred" | "immediate" | "exclusive", (...args: T) => R>;

/**
 * Node's built-in SQLite (also implemented by Bun) behind the better-sqlite3
 * API, so Qone needs neither a native module nor a Bun-only driver.
 */
export class SqliteClient {
  private savepoints = 0;
  constructor(readonly database: DatabaseSync) {}
  exec(sql: string) { this.database.exec(sql); }
  prepare(sql: string) { return new SqliteStatement(this.database.prepare(sql)); }
  close() { if (this.database.isOpen) this.database.close(); }

  transaction<T extends unknown[], R>(fn: (...args: T) => R): Transaction<T, R> {
    const run = (begin: string) => (...args: T): R => {
      // Nested calls become savepoints, matching better-sqlite3.
      const savepoint = this.database.isTransaction ? `qone_${++this.savepoints}` : undefined;
      this.database.exec(savepoint ? `SAVEPOINT ${savepoint}` : begin);
      try {
        const result = fn(...args);
        this.database.exec(savepoint ? `RELEASE ${savepoint}` : "COMMIT");
        return result;
      } catch (error) {
        this.database.exec(savepoint ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : "ROLLBACK");
        throw error;
      }
    };
    return Object.assign(run("BEGIN"), { deferred: run("BEGIN DEFERRED"), immediate: run("BEGIN IMMEDIATE"), exclusive: run("BEGIN EXCLUSIVE") });
  }
}

export type SqliteRunResult = { changes: number | bigint; lastInsertRowid: number | bigint };

/** Same construction as drizzle-orm/better-sqlite3's driver, minus its hard import of the native package. */
export function drizzleSqlite<TSchema extends Record<string, unknown>>(client: SqliteClient, fullSchema: TSchema) {
  const dialect = new SQLiteSyncDialect();
  const tables = extractTablesRelationalConfig(fullSchema, createTableRelationsHelpers);
  const schema = { fullSchema, schema: tables.tables, tableNamesMap: tables.tableNamesMap };
  const session = new BetterSQLiteSession(client as never, dialect, schema as never, {});
  const db = new BaseSQLiteDatabase("sync", dialect, session as never, schema as never) as unknown as
    BaseSQLiteDatabase<"sync", SqliteRunResult, TSchema> & { $client: SqliteClient };
  db.$client = client;
  return db;
}
