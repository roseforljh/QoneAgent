import { afterAll, beforeAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openDb, closeDb } from "@qone/database";
import { BrowserLibrary } from "../src/browser-library.js";

const fixtureRoot = path.join(process.cwd(), ".test-data");
mkdirSync(fixtureRoot, { recursive: true });
const root = mkdtempSync(path.join(fixtureRoot, "browser-sync-"));
const previousLocal = process.env.LOCALAPPDATA;
const previousRoaming = process.env.APPDATA;

beforeAll(() => {
  process.env.LOCALAPPDATA = path.join(root, "local");
  process.env.APPDATA = path.join(root, "roaming");
});

afterAll(() => {
  if (previousLocal === undefined) delete process.env.LOCALAPPDATA;
  else process.env.LOCALAPPDATA = previousLocal;
  if (previousRoaming === undefined) delete process.env.APPDATA;
  else process.env.APPDATA = previousRoaming;
});

test("imports Chromium and Firefox bookmarks/history and keeps prior data on a broken source", () => {
  const chrome = path.join(root, "local", "Google", "Chrome", "User Data", "Default");
  const firefox = path.join(root, "roaming", "Mozilla", "Firefox", "Profiles", "test.default");
  mkdirSync(chrome, { recursive: true });
  mkdirSync(firefox, { recursive: true });
  writeFileSync(path.join(chrome, "Bookmarks"), JSON.stringify({
    roots: { bookmark_bar: { children: [
      { id: "1", type: "url", name: "Qone guide", url: "https://example.com/guide", date_added: "13350000000000000" },
      { id: "2", type: "url", name: "local", url: "file:///private" },
    ] } },
  }));
  const chromeHistory = new Database(path.join(chrome, "History"), { create: true });
  chromeHistory.exec("CREATE TABLE urls (id INTEGER, url TEXT, title TEXT, last_visit_time INTEGER)");
  chromeHistory.query("INSERT INTO urls VALUES (?, ?, ?, ?)").run(1, "https://example.com/news", "Qone news", 13350000000000000);
  chromeHistory.close();
  const places = new Database(path.join(firefox, "places.sqlite"), { create: true });
  places.exec("CREATE TABLE moz_places (id INTEGER, url TEXT, title TEXT, visit_count INTEGER, last_visit_date INTEGER);");
  places.exec("CREATE TABLE moz_bookmarks (id INTEGER, fk INTEGER, type INTEGER, title TEXT, dateAdded INTEGER);");
  places.query("INSERT INTO moz_places VALUES (?, ?, ?, ?, ?)").run(1, "https://mozilla.org/help", "Mozilla help", 2, 1_750_000_000_000_000);
  places.query("INSERT INTO moz_bookmarks VALUES (?, ?, ?, ?, ?)").run(1, 1, 1, "Firefox help", 1_750_000_000_000_000);
  places.close();

  const db = openDb(path.join(root, "qone.db"));
  try {
    const library = new BrowserLibrary(db);
    expect(library.sync()).toMatchObject({ bookmarks: 2, history: 2, errors: [] });
    expect(library.search("Qone")).toHaveLength(2);
    expect(library.search("Firefox", "bookmark")).toHaveLength(1);
    expect(library.sync()).toMatchObject({ bookmarks: 2, history: 2, errors: [] });
    writeFileSync(path.join(chrome, "Bookmarks"), "{broken");
    const failed = library.sync();
    expect(failed.bookmarks).toBe(2);
    expect(failed.history).toBe(2);
    expect(failed.errors).toHaveLength(1);
  } finally {
    closeDb(db);
  }
});
