import { describe, expect, test } from "bun:test";
import { decodeCommand } from "@qone/protocol";
import { buildSessionContext, findCutPoint, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
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

  test("real Pi compaction and checkpoint restore keep summaries and tool declarations in provider requests", async () => {
    const faux = fauxProvider({ provider: "qone-compaction", models: [{ id: "test-model" }] });
    const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const history = [
      { id: "old-user", role: "user", content: "Original request before compaction", createdAt: 1 },
      { id: "old-assistant", role: "assistant", content: "Original answer before compaction", createdAt: 2 },
    ];
    let checkpoint: { throughMessageId: string; context: unknown[] } | undefined;
    const adapter = new PiAdapter(() => {}, {}, undefined,
      () => restoreCompactedContext(history, checkpoint),
      { autoCompactionEnabled: false, compactionThreshold: 80 });
    Object.assign(adapter, { modelRuntime: runtime });
    const summary = "Checkpoint summary: keep the project requirements.";
    const requests: TranscriptContext[] = [];
    faux.setResponses([
      (context) => {
        requests.push(context);
        return fauxAssistantMessage(fauxText(summary));
      },
      ...Array.from({ length: 2 }, () => (context: TranscriptContext) => {
        requests.push(context);
        return fauxAssistantMessage(fauxText("ok"));
      }),
    ]);
    const options = { cwd: process.cwd(), model: "qone-compaction/test-model" };
    try {
      const context = await adapter.compactSession("compaction", options.cwd, options.model);
      checkpoint = { throughMessageId: "old-assistant", context: JSON.parse(JSON.stringify(context)) };
      expect(context.some((message) => (message as { role: string }).role === "compactionSummary")).toBe(true);
      await adapter.run("compaction", "Continue after compaction", options, () => {});
      await adapter.disposeSession("compaction");
      await adapter.run("compaction", "Continue after restart", options, () => {});
      expect(requests).toHaveLength(3);
      expect(JSON.stringify(requests[0]!.messages)).toContain(history[0]!.content);
      for (const [index, prompt] of ["Continue after compaction", "Continue after restart"].entries()) {
        const request = JSON.stringify(requests[index + 1]!.messages);
        expect(request).toContain(summary);
        expect(request).toContain(prompt);
        expect(request).not.toContain(history[0]!.content);
        const tools = getCurrentTools(requests[index + 1]!.messages).map((tool) => tool.name);
        expect(tools).toContain("read");
        expect(tools).toContain("powershell");
        expect(tools).toContain("codemode");
        expect(tools).not.toContain("tool_search");
      }
      // Pi can retain the tail of a split turn. Reopening must preserve exactly
      // that compacted history, without reviving the summarized user request.
      const compactedHistory = (context: TranscriptContext) => context.messages
        .filter((message) => message.role !== "system").slice(0, -1);
      expect(compactedHistory(requests[2]!)).toEqual(compactedHistory(requests[1]!));
      expect(adapter.isRunning("compaction")).toBe(false);
    } finally {
      await adapter.disposeSession("compaction");
    }
  });
});
