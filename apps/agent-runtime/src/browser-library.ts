import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { Db } from "@qone/database";

type Kind = "bookmark" | "history";
interface BrowserItem { id: string; source: string; kind: Kind; title: string; url: string; visitedAt?: number }
interface Profile { browser: string; name: string; folder: string; engine: "chromium" | "firefox" }

function webUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
}

function chromiumTime(value: unknown): number | undefined {
  const micros = Number(value);
  if (!Number.isFinite(micros) || micros <= 0) return undefined;
  const millis = micros / 1000 - 11_644_473_600_000;
  return millis > 0 ? millis : undefined;
}

function item(source: string, kind: Kind, nativeId: string, title: string, url: string, visitedAt?: number): BrowserItem {
  return { id: createHash("sha256").update(`${source}\0${kind}\0${nativeId}`).digest("hex"), source, kind, title, url, visitedAt };
}

function profiles(): Profile[] {
  const found: Profile[] = [];
  const local = process.env.LOCALAPPDATA;
  const roaming = process.env.APPDATA;
  if (local) {
    for (const [browser, relative] of [
      ["Chrome", "Google/Chrome/User Data"],
      ["Edge", "Microsoft/Edge/User Data"],
      ["Brave", "BraveSoftware/Brave-Browser/User Data"],
    ]) {
      const root = path.join(local, relative);
      if (!existsSync(root)) continue;
      for (const name of readdirSync(root)) {
        if (name !== "Default" && !/^Profile \d+$/.test(name)) continue;
        const folder = path.join(root, name);
        if (existsSync(path.join(folder, "Bookmarks")) || existsSync(path.join(folder, "History"))) {
          found.push({ browser, name, folder, engine: "chromium" });
        }
      }
    }
  }
  if (roaming) {
    const root = path.join(roaming, "Mozilla", "Firefox", "Profiles");
    if (existsSync(root)) {
      for (const name of readdirSync(root)) {
        const folder = path.join(root, name);
        if (existsSync(path.join(folder, "places.sqlite"))) found.push({ browser: "Firefox", name, folder, engine: "firefox" });
      }
    }
  }
  return found;
}

function chromiumBookmarks(file: string, source: string): BrowserItem[] {
  if (!existsSync(file)) return [];
  const json = JSON.parse(readFileSync(file, "utf8")) as { roots?: Record<string, unknown> };
  const result: BrowserItem[] = [];
  const walk = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const entry = node as { id?: string; name?: string; url?: string; date_added?: string; children?: unknown[] };
    if (webUrl(entry.url)) result.push(item(source, "bookmark", entry.id ?? entry.url,
      entry.name ?? entry.url, entry.url, chromiumTime(entry.date_added)));
    if (Array.isArray(entry.children)) for (const child of entry.children) walk(child);
  };
  for (const root of Object.values(json.roots ?? {})) walk(root);
  return result;
}

function snapshotSqlite(file: string, read: (db: Database) => BrowserItem[]): BrowserItem[] {
  const directory = mkdtempSync(path.join(tmpdir(), "qone-browser-history-"));
  const copy = path.join(directory, "history.sqlite");
  try {
    copyFileSync(file, copy);
    for (const suffix of ["-wal", "-shm"]) if (existsSync(file + suffix)) copyFileSync(file + suffix, copy + suffix);
    const db = new Database(copy, { readonly: true });
    try { return read(db); } finally { db.close(); }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

function readProfile(profile: Profile): BrowserItem[] {
  const source = `${profile.browser}/${profile.name}`;
  if (profile.engine === "chromium") {
    const bookmarks = chromiumBookmarks(path.join(profile.folder, "Bookmarks"), source);
    const history = existsSync(path.join(profile.folder, "History"))
      ? snapshotSqlite(path.join(profile.folder, "History"), (db) => {
          const rows = db.query("SELECT id, url, title, last_visit_time FROM urls WHERE last_visit_time > 0").all() as
            { id: number; url: string; title: string | null; last_visit_time: number }[];
          return rows.filter((row) => webUrl(row.url)).map((row) => item(source, "history", String(row.id),
            row.title || row.url, row.url, chromiumTime(row.last_visit_time)));
        }) : [];
    return [...bookmarks, ...history];
  }
  return snapshotSqlite(path.join(profile.folder, "places.sqlite"), (db) => {
    const bookmarks = db.query(`SELECT b.id, p.url, COALESCE(b.title, p.title, p.url) AS title, b.dateAdded AS date
      FROM moz_bookmarks b JOIN moz_places p ON p.id = b.fk WHERE b.type = 1`).all() as
      { id: number; url: string; title: string; date: number }[];
    const history = db.query("SELECT id, url, COALESCE(title, url) AS title, last_visit_date AS date FROM moz_places WHERE visit_count > 0").all() as
      { id: number; url: string; title: string; date: number | null }[];
    return [
      ...bookmarks.filter((row) => webUrl(row.url)).map((row) => item(source, "bookmark", String(row.id), row.title, row.url, row.date / 1000)),
      ...history.filter((row) => webUrl(row.url)).map((row) => item(source, "history", String(row.id), row.title, row.url,
        row.date ? row.date / 1000 : undefined)),
    ];
  });
}

export class BrowserLibrary {
  private readonly sqlite: Database;

  constructor(db: Db) {
    this.sqlite = db.$client;
    this.sqlite.exec(`CREATE TABLE IF NOT EXISTS browser_items (
      id TEXT PRIMARY KEY, source TEXT NOT NULL, kind TEXT NOT NULL, title TEXT NOT NULL,
      url TEXT NOT NULL, visited_at INTEGER
    ); CREATE INDEX IF NOT EXISTS idx_browser_items_source ON browser_items(source);
    CREATE INDEX IF NOT EXISTS idx_browser_items_kind_visit ON browser_items(kind, visited_at DESC);`);
  }

  sync(): { bookmarks: number; history: number; errors: string[] } {
    const errors: string[] = [];
    for (const profile of profiles()) {
      try {
        const entries = readProfile(profile);
        const source = `${profile.browser}/${profile.name}`;
        this.sqlite.transaction(() => {
          this.sqlite.query("DELETE FROM browser_items WHERE source = ?").run(source);
          const insert = this.sqlite.query("INSERT INTO browser_items (id, source, kind, title, url, visited_at) VALUES (?, ?, ?, ?, ?, ?)");
          for (const entry of entries) insert.run(entry.id, entry.source, entry.kind, entry.title, entry.url, entry.visitedAt ?? null);
        })();
      } catch (error) {
        errors.push(`${profile.browser}/${profile.name}: ${String(error)}`);
      }
    }
    const counts = this.sqlite.query("SELECT kind, COUNT(*) AS total FROM browser_items GROUP BY kind").all() as { kind: Kind; total: number }[];
    return {
      bookmarks: counts.find((row) => row.kind === "bookmark")?.total ?? 0,
      history: counts.find((row) => row.kind === "history")?.total ?? 0,
      errors,
    };
  }

  search(query: string, kind?: Kind): BrowserItem[] {
    const pattern = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    return this.sqlite.query(`SELECT id, source, kind, title, url, visited_at AS visitedAt FROM browser_items
      WHERE (title LIKE ? ESCAPE '\\' OR url LIKE ? ESCAPE '\\') AND (? IS NULL OR kind = ?)
      ORDER BY visited_at DESC LIMIT 30`).all(pattern, pattern, kind ?? null, kind ?? null) as BrowserItem[];
  }

  tool(): ToolDefinition {
    return {
      name: "qone_browser_search",
      label: "Search imported browser bookmarks and history",
      description: "Search bookmarks and browsing history imported from the user's local browsers. Results do not include passwords or cookies.",
      parameters: Type.Object({ query: Type.String(), kind: Type.Optional(Type.Union([Type.Literal("bookmark"), Type.Literal("history")])) }),
      execute: async (_id, args: { query: string; kind?: Kind }) => ({
        content: [{ type: "text", text: JSON.stringify(this.search(args.query, args.kind)) }],
      }) as never,
    };
  }
}
