// The app opens the DB with the hand-written bootstrap in src/index.ts, but
// drizzle/*.sql is the schema history a drizzle-kit consumer would replay.
// When the two drift, a migrated database and a shipped one disagree — this
// test fails instead of that.
import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, openDb } from "../src/index";

const drizzleDir = path.join(import.meta.dir, "../drizzle");

function applyChain(): Database {
  const db = new Database(":memory:");
  db.exec("PRAGMA foreign_keys = ON;");
  for (const file of readdirSync(drizzleDir).filter((f) => f.endsWith(".sql")).sort()) {
    db.exec(readFileSync(path.join(drizzleDir, file), "utf8"));
  }
  return db;
}

function describeSchema(db: { query(sql: string): { all(): unknown[] } }): Map<string, string[]> {
  const tables = new Map<string, string[]>();
  const rows = db.query("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[];
  for (const { name } of rows) {
    const columns = db.query(`PRAGMA table_info(${name})`).all() as { name: string; type: string }[];
    tables.set(name, columns.map((c) => `${c.name}:${c.type}`));
  }
  return tables;
}

describe("drizzle migration chain", () => {
  test("replays cleanly and matches the bootstrap schema", () => {
    const chain = applyChain();
    const tmp = path.join(os.tmpdir(), `qone-schema-parity-${Date.now()}.db`);
    const boot = openDb(tmp);
    try {
      const fromChain = describeSchema(chain);
      const fromBootstrap = describeSchema(boot.$client as unknown as { query(sql: string): { all(): unknown[] } });

      const missingTables = [...fromBootstrap.keys()].filter((table) => !fromChain.has(table)).sort();
      expect(missingTables).toEqual([]);
      const extraTables = [...fromChain.keys()].filter((table) => !fromBootstrap.has(table)).sort();
      expect(extraTables).toEqual([]);

      for (const [table, columns] of fromBootstrap) {
        const chainColumns = fromChain.get(table)!;
        expect(
          { table, missing: columns.filter((c) => !chainColumns.includes(c)) },
          `${table} columns missing from drizzle/*.sql`,
        ).toEqual({ table, missing: [] });
      }
    } finally {
      chain.close();
      closeDb(boot);
      rmSync(tmp, { force: true });
    }
  });
});