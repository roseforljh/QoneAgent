import { describe, expect, test } from "bun:test";
import type { SettingsRepo } from "@qone/database";
import { MemoryStore } from "../src/memory/memory-store";
import { MemoryConsolidator } from "../src/memory/memory-consolidator";
import { MemoryService, MEMORY_TOOL } from "../src/memory/memory-service";

function repo() {
  const values = new Map<string, unknown>();
  return { get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: unknown) => values.set(key, value) } as unknown as SettingsRepo;
}

const NOW = 100 * 24 * 60 * 60_000;
const OVERVIEW = "## User profile\nNone\n## User preferences\nNone\n## General tips\nNone\n## What's in memory\n### Qone\n- [conv:a] 2026-01-01 — memory work";

describe("memory", () => {
  test("summarizes idle chats, consolidates once, and drops writes from a stale version", async () => {
    const store = new MemoryStore(repo());
    store.setEnabled(true);
    const sessions = [
      { id: "a", title: "A", updatedAt: NOW - 20 * 60_000 },
      { id: "current", title: "C", updatedAt: NOW - 20 * 60_000 },
      { id: "fresh", title: "F", updatedAt: NOW - 60_000 },
    ];
    const consolidator = new MemoryConsolidator(store, {
      candidates: () => sessions,
      transcript: () => [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    }, () => NOW);
    const calls: string[] = [];
    const complete = async (system: string) => {
      calls.push(system.includes("Consolidate") ? "overview" : "summary");
      return { text: system.includes("Consolidate") ? OVERVIEW : JSON.stringify({ title: "Memory", summary: "token sk-abcdefghijkl was used" }), tokens: 10 };
    };
    await consolidator.runOnce(complete, "current", store.settings().version);
    expect(calls).toEqual(["summary", "overview"]);
    expect(store.summaries().map((item) => item.id)).toEqual(["a"]);
    expect(store.summary("a")!.content).toContain("[REDACTED]");
    expect(store.state().stats).toMatchObject({ calls: 2, tokens: 20 });

    await consolidator.runOnce(complete, "current", store.settings().version);
    expect(calls).toHaveLength(2);

    const stale = store.settings().version;
    store.forgetSummary("a");
    await consolidator.runOnce(complete, "current", stale);
    expect(calls).toHaveLength(2);
    expect(store.summary("a")).toBeUndefined();
  });

  test("tool saves only explicit, quoted requests", async () => {
    const store = new MemoryStore(repo());
    store.setEnabled(true);
    const service = new MemoryService({
      store, source: { candidates: () => [], transcript: () => [] }, searchConversations: () => [],
      complete: () => async () => ({ text: "", tokens: 0 }), onChange: () => {}, onError: () => {},
    });
    const run = async (args: Record<string, string>) => {
      const [tool] = service.tools("s");
      const result = await tool!.execute("t", args as never, undefined, undefined, undefined as never);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    service.context("s", "我喜欢深色主题");
    expect((await run({ action: "save", content: "喜欢深色主题", evidence: "深色主题" })).ok).toBe(false);
    service.context("s", "请记住：我喜欢深色主题");
    expect((await run({ action: "save", content: "喜欢深色主题", evidence: "编造" })).ok).toBe(false);
    expect((await run({ action: "save", content: "喜欢深色主题", evidence: "我喜欢深色主题" })).ok).toBe(true);
    expect(store.notes().map((note) => note.content)).toEqual(["喜欢深色主题"]);
    expect(service.context("s", "hi")).toContain("喜欢深色主题");
    store.setEnabled(false);
    expect(service.tools("s").map((tool) => tool.name)).not.toContain(MEMORY_TOOL);
    expect(service.context("s", "hi")).toBe("");
  });
});
