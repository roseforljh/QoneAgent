import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Db } from "@qone/database";

/** Copy a database to a temporary file (the portable form of serialize) and return its path for openDb. */
export function snapshotDb(db: Db): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), "qone-db-snapshot-")), "snapshot.db");
  db.$client.exec(`VACUUM INTO '${file.replaceAll("'", "''")}'`);
  return file;
}
