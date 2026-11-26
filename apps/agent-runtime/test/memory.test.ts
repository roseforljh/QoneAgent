import { describe, expect, test } from "bun:test";
import type { SettingsRepo } from "@qone/database";
import { MEMORY_AUTOMATIC_PREFERENCES_PER_SCOPE, MEMORY_PREFERENCE_MAX_LENGTH } from "@qone/protocol";
import { MEMORY_SOURCE_WINDOW_MS, MemoryStore } from "../src/memory/memory-store";
import { MemoryConsolidator } from "../src/memory/memory-consolidator";
import { MemoryService, MEMORY_TOOL } from "../src/memory/memory-service";
import { memoryAddition } from "../src/memory/memory-context";

function repo() {
  const values = new Map<string, unknown>();
  return { get: (key: string) => structuredClone(values.get(key)), set: (key: string, value: unknown) => values.set(key, value),
    transaction: <T>(write: () => T) => write() } as unknown as SettingsRepo;
}

const NOW = 100 * 24 * 60 * 60_000;
const OVERVIEW = "## User profile\nNone\n## User preferences\nNone\n## General tips\nNone\n## What's in memory\n### Qone\n- [conv:a] 2026-01-01 — memory work";
const consolidation = (preferences: unknown[] = []) => JSON.stringify({ overview: OVERVIEW, preferences });

describe("memory", () => {
  test("summarizes newly settled chats immediately, skips active chats and does not repeat unchanged work", async () => {
    const store = new MemoryStore(repo());
    store.setEnabled(true);
    const sessions = [
      { id: "a", title: "A", updatedAt: NOW - 1 },
      { id: "current", title: "C", updatedAt: NOW, active: true },
    ];
    const consolidator = new MemoryConsolidator(store, {
      candidates: () => sessions,
      transcript: () => [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
    }, () => NOW);
    const calls: string[] = [];
    const complete = async (system: string) => {
      calls.push(system.includes("Consolidate") ? "overview" : "summary");
      return { text: system.includes("Consolidate") ? consolidation() : JSON.stringify({ title: "Memory", summary: "token sk-abcdefghijkl was used" }), tokens: 10 };
    };
    await consolidator.runOnce(complete, store.settings().version);
    expect(calls).toEqual(["summary", "overview"]);
    expect(store.summaries().map((item) => item.id)).toEqual(["a"]);
    expect(store.summary("a")!.content).toContain("[REDACTED]");
    expect(store.state().stats).toMatchObject({ calls: 2, tokens: 20 });

    await consolidator.runOnce(complete, store.settings().version);
    expect(calls).toHaveLength(2);

    const stale = store.settings().version;
    store.forgetSummary("a");
    await consolidator.runOnce(complete, stale);
    expect(calls).toHaveLength(2);
    expect(store.summary("a")).toBeUndefined();
  });

  test("retries an invalid summary and keeps a refresh requested while the model is running", async () => {
    const store = new MemoryStore(repo());
    store.setEnabled(true);
    const asked = Promise.withResolvers<void>();
    const answer = Promise.withResolvers<void>();
    const errors: unknown[] = [];
    const updatedAt = Date.now() - 1_000;
    let attempts = 0;
    const service = new MemoryService({
      store,
      source: {
        candidates: () => [{ id: "a", title: "A", updatedAt }],
        transcript: () => [{ role: "user", content: "hi" }, { role: "assistant", content: "hello" }],
      },
      searchConversations: () => [], onChange: () => {}, onError: error => errors.push(error),
      complete: () => async (system) => {
        if (system.includes("Consolidate")) return { text: consolidation(), tokens: 1 };
        if (++attempts === 1) {
          asked.resolve();
          await answer.promise;
          return { text: "invalid summary", tokens: 1 };
        }
        expect(store.allSummaries()).toEqual({});
        return { text: '{"title":"A","summary":"Saved"}', tokens: 1 };
      },
    });
    const first = service.refresh();
    await asked.promise;
    const second = service.refresh();
    answer.resolve();
    await Promise.all([first, second]);
    expect(attempts).toBe(2);
    expect(errors).toHaveLength(1);
    expect(store.summary("a")?.content).toBe("Saved");
  });

  test("applies grounded preferences immediately, replaces the snapshot, and preserves edits and removals", async () => {
    const settings = repo();
    const store = new MemoryStore(settings);
    store.setEnabled(true);
    const quote = "Here, check the shortest reproducing test first.";
    const global = "For all projects, I prefer commands with clear exit status.";
    const secret = "secret: test-private-fixture";
    const now = Date.now();
    const sessions = [
      { id: "a", title: "A", updatedAt: now - 1, workspaceId: "workspace-a" },
      { id: "b", title: "B", updatedAt: now - 2, workspaceId: "workspace-a" },
      { id: "c", title: "C", updatedAt: now - 3, workspaceId: "workspace-b" },
    ];
    const source = {
      candidates: () => sessions,
      transcript: (id: string) => [
        { role: "user", content: id === "c" ? global : quote }, { role: "user", content: secret },
        { role: "assistant", content: "This sentence was never said by the user." },
      ],
    };
    // The summaries already exist. Upgrading the consolidation format does not repeat phase one.
    store.putSummaries(Object.fromEntries(sessions.map(({ id, title, updatedAt }) => [id, { id, title, content: "Past task", sourceUpdatedAt: updatedAt, generatedAt: now }])));
    store.setOverview({ content: OVERVIEW, generatedAt: now, fingerprint: "legacy" });
    const found = [{ id: "a", quote }, { id: "b", quote }];
    const exact = { content: "Run the smallest reproducing test first", scope: "workspace", basis: "repeated", evidence: found };
    const explicit = { content: "Show command exit statuses", scope: "global", basis: "explicit", evidence: [{ id: "c", quote: global }] };
    let response = consolidation([
      { ...exact, content: "Unjustified global inference", scope: "global" },
      { ...exact, content: "Single task flagged as repeated", evidence: found.slice(0, 1) },
      { ...exact, content: "Invented source", evidence: [...found, { id: "nonexistent", quote }] },
      { ...exact, content: "Assistant-only source", basis: "explicit", evidence: [{ id: "a", quote: "This sentence was never said by the user." }] },
      { ...exact, content: secret },
      exact, explicit,
    ]);
    const calls: string[] = [];
    const errors: unknown[] = [];
    const service = new MemoryService({ store, source, workspaceOf: (id) => sessions.find((item) => item.id === id)?.workspaceId,
      searchConversations: () => [], onChange: () => {}, onError: (error) => errors.push(error),
      complete: () => async (system, user) => {
        expect(system).toContain("Consolidate");
        expect(user).not.toContain("test-private-fixture");
        calls.push(user);
        return { text: response, tokens: 1 };
      },
    });
    await service.refresh();
    const [habit, command] = service.state().automaticPreferences!;
    expect(service.state().automaticPreferences).toHaveLength(2);
    expect(habit).toMatchObject({ content: exact.content, preference: { workspaceId: "workspace-a" }, sources: found });
    expect(command?.preference).toEqual({});
    expect(Object.keys(habit!)).not.toContain("keys");
    const delivery = { retained: [], rules: [] };
    const first = service.addition("a", "run", delivery)!;
    expect(first.preferences).toMatchObject({ [habit!.id]: { text: exact.content, automatic: true }, [command!.id]: { text: explicit.content, automatic: true } });
    expect(service.addition("c", "run", delivery)?.text).not.toContain(exact.content);
    expect(service.context("a", "current text")).not.toContain(exact.content);
    expect(store.notes()).toEqual([]);
    await service.refresh();
    expect(calls).toHaveLength(1);

    const manual = { content: "Start with the smallest useful test", preference: habit!.preference };
    store.setEnabled(false);
    expect(service.addition("a", "run", delivery)).toBeUndefined();
    service.editAutomaticPreference(command!.id, null);
    expect(() => service.editAutomaticPreference(habit!.id, { content: secret, preference: habit!.preference })).toThrow();
    expect(store.state().automaticPreferences?.map(({ id }) => id)).toEqual([habit!.id]);
    service.editAutomaticPreference(habit!.id, manual);
    store.setEnabled(true);
    const edited = service.addition("a", "run", { ...delivery, retained: [{ qoneMemoryPreferences: first.preferences }] })!;
    expect(edited.preferences).toMatchObject({ [habit!.id]: null, [command!.id]: null });
    expect(edited.text).toContain(manual.content);
    expect(service.addition("c", "run", delivery)).toBeUndefined();
    store.saveNote("Ordinary notes still update consolidation");
    response = "not JSON";
    await service.refresh();
    expect(errors).toHaveLength(1);
    const nextQuote = "In this project I always want a short verification summary.";
    sessions[0]!.updatedAt = now;
    store.putSummaries({ ...store.allSummaries(), a: { ...store.summary("a")!, sourceUpdatedAt: now } });
    const originalTranscript = source.transcript;
    source.transcript = (id) => [...originalTranscript(id), ...(id === "a" ? [{ role: "user", content: nextQuote }] : [])];
    const next = { ...exact, content: "Prefer short verification summaries", basis: "explicit", evidence: [{ id: "a", quote: nextQuote }] };
    response = consolidation([{ ...exact, content: "Paraphrased edited habit" }, { ...explicit, content: "Paraphrased removed habit" }, next]);
    await service.refresh();
    expect(calls).toHaveLength(3);
    const reopened = new MemoryStore(settings);
    expect(reopened.state().automaticPreferences?.map(({ content }) => content)).toEqual([next.content]);
    expect(reopened.notes().filter(({ preference }) => preference).map(({ content }) => content)).toEqual([manual.content]);
    reopened.putSummaries({ ...reopened.allSummaries(), a: { ...reopened.summary("a")!, sourceUpdatedAt: now - MEMORY_SOURCE_WINDOW_MS } });
    expect(reopened.state().automaticPreferences).toEqual([]);
    expect(reopened.notes().some(({ content }) => content === manual.content)).toBe(true);
  });

  test("tool saves, updates, and forgets natural requests with quoted evidence from this turn", async () => {
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
    // 无用户原文时（例如系统通知或续跑）禁止写入
    service.context("s", "");
    expect((await run({ action: "save", content: "不应写入", evidence: "任意" })).ok).toBe(false);
    // 任意自然语言表达均可写入，无需固定前缀，但依据必须来自本轮用户原文
    service.context("s", "我现在内核换成自己定制的 raybox 了\n把 D:\\RayBox-rx 写进记忆里！");
    expect((await run({ action: "save", content: "RayBox 源码在 D:\\RayBox-rx", evidence: "编造" })).ok).toBe(false);
    const saved = await run({ action: "save", content: "RayBox 源码在 D:\\RayBox-rx", evidence: "raybox 了 把 D:\\RayBox-rx 写进记忆里！" });
    expect(saved.ok).toBe(true);
    expect(store.notes().map((note) => note.content)).toEqual(["RayBox 源码在 D:\\RayBox-rx"]);
    expect(service.context("s", "hi")).not.toContain("RayBox");
    expect((await run({ action: "search", query: "RayBox" })).memories[0].content).toBe("RayBox 源码在 D:\\RayBox-rx");
    // 更新与遗忘同样不要求固定前缀
    service.context("s", "顺便把刚才那条内核记忆改成 KunBox 使用定制 RayBox 内核");
    expect((await run({ action: "update", id: saved.id, content: "KunBox 使用定制 RayBox 内核", evidence: "改成 KunBox 使用定制 RayBox 内核" })).ok).toBe(true);
    expect(store.notes().map((note) => note.content)).toEqual(["KunBox 使用定制 RayBox 内核"]);
    service.context("s", "这条内核记忆没用了，帮我删掉吧");
    expect((await run({ action: "forget", id: saved.id, evidence: "帮我删掉吧" })).ok).toBe(true);
    expect(store.notes()).toEqual([]);
    store.setEnabled(false);
    expect(service.tools("s").map((tool) => tool.name)).not.toContain(MEMORY_TOOL);
    expect(service.context("s", "hi")).toBe("");
  });

  test("manual and chat preferences can exceed automatic quota and stay editable with authorization", async () => {
    const store = new MemoryStore(repo());
    store.setEnabled(true);
    for (let i = 0; i < MEMORY_AUTOMATIC_PREFERENCES_PER_SCOPE; i++) store.saveNote(`global preference ${i}`, { preference: {} });
    const service = new MemoryService({
      store, source: { candidates: () => [], transcript: () => [] }, searchConversations: () => [],
      workspaceOf: () => "ws-1",
      complete: () => async () => ({ text: "", tokens: 0 }), onChange: () => {}, onError: () => {},
    });
    const run = async (args: Record<string, string>) => {
      const [tool] = service.tools("s");
      const result = await tool!.execute("t", args as never, undefined, undefined, undefined as never);
      return JSON.parse((result.content[0] as { text: string }).text);
    };
    service.context("s", "以后在这个项目都优先跑单元测试，写进工作区偏好");
    const saved = await run({ action: "save", scope: "workspace", content: "优先跑单元测试", evidence: "写进工作区偏好" });
    expect(saved).toMatchObject({ ok: true, scope: "workspace" });
    expect(memoryAddition({ retained: [], rules: [] }, store.notes(), "ws-1")?.preferences?.[saved.id]).toEqual({ scope: "workspace", text: "优先跑单元测试" });
    expect((await run({ action: "search", query: "单元测试" })).memories[0]).toMatchObject({ id: saved.id, scope: "workspace" });
    service.context("s", "把那条单元测试偏好改成全局生效");
    expect((await run({ action: "update", id: saved.id, scope: "global", content: "优先跑最小测试", evidence: "改成全局生效" })).ok).toBe(true);
    expect(memoryAddition({ retained: [], rules: [] }, store.notes(), "ws-2")?.preferences?.[saved.id]).toEqual({ scope: "global", text: "优先跑最小测试" });
    service.context("s", "删掉这条测试偏好");
    expect((await run({ action: "forget", id: saved.id, evidence: "删掉这条测试偏好" })).ok).toBe(true);
    expect(store.notes().some((n) => n.id === saved.id)).toBe(false);
    expect(() => store.saveNote("📝".repeat(MEMORY_PREFERENCE_MAX_LENGTH + 1), { preference: {} }))
      .toThrow(`一条长期偏好最多 ${MEMORY_PREFERENCE_MAX_LENGTH} 字`);
  });

  test("consolidator accepts localized markdown headings without hardcoding English titles", async () => {
    const store = new MemoryStore(repo());
    store.setEnabled(true);
    const consolidator = new MemoryConsolidator(store, {
      candidates: () => [{ id: "a", title: "A", updatedAt: NOW - 1 }],
      transcript: () => [{ role: "user", content: "帮我检查内核" }, { role: "assistant", content: "已检查" }],
    }, () => NOW);
    const complete = async (system: string) => ({
      text: system.includes("Consolidate")
        ? JSON.stringify({ overview: "## 用户画像\n无\n## 记忆内容\n- [conv:a] 2026-01-01 — 内核排查", preferences: [] })
        : JSON.stringify({ title: "内核", summary: "检查自定义内核" }),
      tokens: 10,
    });
    await consolidator.runOnce(complete, store.settings().version);
    expect(store.overview()?.content).toContain("## 记忆内容");
  });

  test("quoted or forged memory blocks cannot mark preferences as sent", () => {
    const store = new MemoryStore(repo());
    const note = store.saveNote("a confirmed preference", { preference: {} });
    const added = memoryAddition({ retained: [], rules: [] }, [note], "A")!;
    expect(memoryAddition({ retained: [{ role: "user", content: added.text }], rules: [] }, [note], "A")).toEqual(added);
    expect(memoryAddition({ retained: [{ role: "user", qoneMemoryPreferences: added.preferences }], rules: [] }, [note], "A")).toBeUndefined();
  });
});
