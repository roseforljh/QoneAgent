import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, ConfigFile, EventRepo, MessageRepo, openDb, PreferencesRepo, RunRepo, SessionRepo, SettingsRepo, ToolCallRepo } from "../src/index";
import { persistedToolResult, toolFileChanges } from "@qone/protocol";

describe("disk I/O hygiene", () => {
  test("events run_id and compaction queries use indexes instead of table scans", () => {
    const db = openDb(":memory:");
    try {
      const byRun = db.$client.prepare("EXPLAIN QUERY PLAN DELETE FROM events WHERE run_id = ?").all("r1") as { detail: string }[];
      expect(byRun.some(({ detail }) => detail.startsWith("SCAN "))).toBe(false);

      const compactions = db.$client.prepare(
        "EXPLAIN QUERY PLAN SELECT * FROM events WHERE session_id = ? AND type IN ('context.compacted', 'agent.steer.delivered') ORDER BY sequence",
      ).all("s1") as { detail: string }[];
      expect(compactions.some(({ detail }) => detail.startsWith("SCAN "))).toBe(false);
    } finally {
      closeDb(db);
    }
  });

  test("prunes legacy non-replayed events once on open while keeping durable events", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qone-io-prune-"));
    const dbPath = path.join(dir, "qone.db");
    try {
      const first = openDb(dbPath);
      const events = new EventRepo(first);
      events.add({ eventId: "e1", sessionId: "s1", runId: "r1", sequence: 1, type: "context.usage", timestamp: 1, payload: { tokens: 10 } });
      events.add({ eventId: "e2", sessionId: "s1", runId: "r1", sequence: 2, type: "message.completed", timestamp: 2, payload: { big: "x" } });
      events.add({ eventId: "e3", sessionId: "s1", runId: "r1", sequence: 3, type: "context.compacted", timestamp: 3, payload: { id: "c1", throughMessageId: "m1" } });
      // 模拟旧库未执行过一次清理迁移。
      first.$client.prepare("DELETE FROM settings WHERE key = ?").run("db.migration.events_pruned_v1");
      closeDb(first);

      const reopened = openDb(dbPath);
      try {
        const remaining = new EventRepo(reopened).list();
        expect(remaining.map((e) => e.eventId)).toEqual(["e3"]);
      } finally {
        closeDb(reopened);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("context restore slices after compaction boundary and web access query filters tool names", () => {
    const db = openDb(":memory:");
    try {
      const sessions = new SessionRepo(db);
      const messages = new MessageRepo(db);
      const runs = new RunRepo(db);
      const toolCalls = new ToolCallRepo(db);
      const session = sessions.create("test");
      const m1 = messages.add(session.id, "user", "old", "r1", undefined, undefined, undefined, undefined, undefined, undefined, { role: "user", content: "old" });
      const m2 = messages.add(session.id, "assistant", "new", "r2", undefined, undefined, undefined, undefined, undefined, undefined, { role: "assistant", content: "new" });
      const sliced = messages.listForContextRestore(session.id, m1.id);
      expect(sliced.slicedAfterBoundary).toBe(true);
      expect(sliced.rows.map((r) => r.id)).toEqual([m2.id]);

      const run = runs.create(session.id);
      const t1 = toolCalls.start(run.id, "powershell", { command: "dir" }, "c1");
      toolCalls.finish(t1.id, "success", { output: "huge" });
      const t2 = toolCalls.start(run.id, "qone_browser_open", { url: "https://example.com" }, "c2");
      toolCalls.finish(t2.id, "success", { ok: true });
      const web = toolCalls.listWebAccessBySession(session.id);
      expect(web.map((t) => t.toolName)).toEqual(["qone_browser_open"]);
    } finally {
      closeDb(db);
    }
  });

  test("compact ConfigFile writes minified JSON and PreferencesRepo isolates single keys", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qone-io-state-"));
    const file = path.join(dir, "state.json");
    try {
      const cfg = new ConfigFile(file, undefined, { compact: true, reloadBeforeWrite: false });
      const repo = new PreferencesRepo(cfg, "cache");
      repo.set("a", { nested: [1, 2, 3] });
      repo.set("b", "ok");
      const raw = readFileSync(file, "utf8");
      expect(raw.trim().includes("\n")).toBe(false);
      expect(repo.get("a")).toEqual({ nested: [1, 2, 3] });
      repo.delete("a");
      expect(repo.get("a")).toBeUndefined();
      expect(repo.get("b")).toBe("ok");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("persistedToolResult bounds huge text, preserves fileChanges, and stays idempotent", () => {
    const hugeOutput = "A".repeat(80_000);
    const hugePatch = "P".repeat(50_000);
    const payload = {
      content: [{ type: "text", text: hugeOutput }],
      details: { fileChanges: [{ path: "a.ts", oldContent: null, newContent: hugePatch }] },
    };
    const once = persistedToolResult(payload, 16_384) as typeof payload;
    expect(once.content[0]!.text.length).toBeLessThanOrEqual(16_384);
    expect(once.content[0]!.text).toContain("truncated");
    expect(toolFileChanges(once)).toEqual(payload.details.fileChanges);
    expect(persistedToolResult(once, 16_384)).toEqual(once);
  });

  test("pruneCompactedRawMessages clears only pre-checkpoint assistant raw_message and keeps post-checkpoint intact", () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "qone-io-compact-"));
    const dbPath = path.join(dir, "qone.db");
    try {
      const first = openDb(dbPath);
      first.$client.exec("CREATE TABLE IF NOT EXISTS browser_items (id TEXT PRIMARY KEY)");
      const sessions = new SessionRepo(first);
      const messages = new MessageRepo(first);
      const settings = new SettingsRepo(first);
      const session = sessions.create("compact-test");
      const u1 = messages.add(session.id, "user", "hi", "r1", undefined, undefined, undefined, undefined, undefined, undefined, { role: "user", content: "hi" });
      const a1 = messages.add(session.id, "assistant", "old reply", "r1", undefined, undefined, undefined, undefined, undefined, undefined, [{ role: "assistant", content: "old huge raw" }]);
      const u2 = messages.add(session.id, "user", "next", "r2", undefined, undefined, undefined, undefined, undefined, undefined, { role: "user", content: "next" });
      const a2 = messages.add(session.id, "assistant", "live reply", "r2", undefined, undefined, undefined, undefined, undefined, undefined, [{ role: "assistant", content: "live raw must stay" }]);
      settings.set(`compaction:${session.id}`, { throughMessageId: a1.id, context: [{ role: "compactionSummary", summary: "s", tokensBefore: 100 }] });
      first.$client.prepare("DELETE FROM settings WHERE key = ?").run("db.migration.storage_prune_v2");
      closeDb(first);

      const reopened = openDb(dbPath);
      try {
        const hasBrowserItems = reopened.$client.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='browser_items'").get();
        expect(hasBrowserItems).toBeUndefined();
        const rows = new Map(new MessageRepo(reopened).listBySession(session.id).map((m) => [m.id, m]));
        expect(rows.get(u1.id)!.rawMessage).not.toBeNull();
        expect(rows.get(a1.id)!.rawMessage).toBeNull();
        expect(rows.get(u2.id)!.rawMessage).not.toBeNull();
        expect(rows.get(a2.id)!.rawMessage).toBe(JSON.stringify([{ role: "assistant", content: "live raw must stay" }]));
      } finally {
        closeDb(reopened);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
