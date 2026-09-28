import { describe, expect, test } from "bun:test";
import { decodeCommand } from "@qone/protocol";
import { buildSessionContext, findCutPoint, SettingsManager } from "@earendil-works/pi-coding-agent";
import { createPiSessionEntries, PiAdapter } from "../src/pi-adapter.js";
import { restoreCompactedContext } from "../src/session-compaction.js";

describe("manual session compaction", () => {
  test("validates the command independently of auto-compaction settings", () => {
    expect(decodeCommand(JSON.stringify({ type: "session.compact", requestId: "request", sessionId: "session", model: "provider/model" }))?.type).toBe("session.compact");
    expect(decodeCommand(JSON.stringify({ type: "session.compact", requestId: "request", sessionId: "session" }))).toBeNull();
  });

  test("restores the compacted Pi context and only newer SQLite messages", () => {
    const history = [
      { id: "old-user", role: "user", content: "long old request", createdAt: 1 },
      { id: "old-assistant", role: "assistant", content: "long old answer", createdAt: 2 },
      { id: "new-user", role: "user", content: "follow up", createdAt: 3 },
    ];
    const summary = { role: "compactionSummary", summary: "old context", tokensBefore: 12, timestamp: 2 };
    const restored = restoreCompactedContext(history, { throughMessageId: "old-assistant", context: [summary] });
    expect(restored.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
    const entries = createPiSessionEntries("C:/workspace", restored).slice(1);
    expect(entries.map((entry) => entry.type === "message" ? entry.message.role : entry.type)).toEqual(["compactionSummary", "user"]);
    expect(buildSessionContext(entries).messages.map((message) => message.role)).toEqual(["compactionSummary", "user"]);
    expect(restoreCompactedContext(history, { throughMessageId: "deleted-message", context: [summary] })).toEqual(history);
  });

  test("zero retained tokens selects a cut point even in a short chat", () => {
    const entries = createPiSessionEntries("C:/workspace", [
      { role: "user", content: "short question", createdAt: 1 },
      { role: "assistant", content: "short answer", createdAt: 2 },
    ], { api: "openai-completions", provider: "demo", id: "model" });
    expect(findCutPoint(entries, 0, entries.length, 20_000).firstKeptEntryIndex).toBe(0);
    expect(findCutPoint(entries, 0, entries.length, 0).firstKeptEntryIndex).toBe(2);
  });

  test("calls Pi manual compaction with zero retained tokens even when auto-compaction is off", async () => {
    const adapter = new PiAdapter(() => {}, {}, undefined, undefined, { autoCompactionEnabled: false, compactionThreshold: 80 });
    const settings = SettingsManager.inMemory({ compaction: { enabled: false, keepRecentTokens: 20_000 } });
    (adapter as unknown as { sessionSettingsManagers: Map<string, SettingsManager> }).sessionSettingsManagers.set("session", settings);
    const summary = { role: "compactionSummary", summary: "short chat", tokensBefore: 10, timestamp: 2 };
    Object.assign(adapter, { getSession: async () => ({
      isIdle: true,
      model: { provider: "demo", id: "model" },
      compact: async () => {
        expect(settings.getCompactionSettings({ provider: "demo", id: "model" })).toMatchObject({ enabled: false, keepRecentTokens: 0 });
      },
      agent: { state: { messages: [summary] } },
    }) });
    expect(await adapter.compactSession("session", "C:/workspace", "demo/model")).toEqual([summary]);
    expect(settings.getCompactionKeepRecentTokens()).toBe(20_000);
  });
});
