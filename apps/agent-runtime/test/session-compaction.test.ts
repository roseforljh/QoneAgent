import { describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { dirname } from "node:path";
import { snapshotDb } from "./db-snapshot";
import { decodeCommand, type AgentEvent } from "@qone/protocol";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo, SettingsRepo } from "@qone/database";
import { buildSessionContext, findCutPoint, ModelRuntime, SettingsManager } from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxText } from "@earendil-works/pi-ai/providers/faux";
import type { TranscriptContext } from "@earendil-works/pi-ai";
import { getCurrentTools } from "@earendil-works/pi-ai/utils/transcript";
import { createPiSessionEntries, PiAdapter } from "../src/pi-adapter.js";
import { automaticCompactionBoundary, restoreCompactedContext, type SessionCompactionCheckpoint } from "../src/session-compaction.js";

test("automatic checkpoints keep pending input and only trim the saved assistant segment prefix", () => {
  const old = { id: "old", role: "assistant", content: "old", createdAt: 1 };
  const user = { id: "user", role: "user", content: "new input", runId: "r", createdAt: 2 };
  const retained = { role: "assistant", timestamp: 3 };
  const summary = { role: "compactionSummary", summary: "earlier work", tokensBefore: 100, timestamp: 4 };
  const nextTool = { role: "toolResult", timestamp: 5 };
  const communication = { id: "notice", role: "user", content: "message from a child", runId: "r", communication: true, createdAt: 5, rawMessage: { role: "user", content: "message from a child", timestamp: 5 } };
  const assistant = { id: "answer", role: "assistant", content: "visible text", runId: "r", createdAt: 6, rawMessage: [retained, nextTool] };
  expect(automaticCompactionBoundary([old, user], "r", false, 0)).toEqual({ throughMessageId: old.id });
  const boundary = automaticCompactionBoundary([old, user], "r", true, 1)!;
  const restored = restoreCompactedContext([old, user, communication, assistant], { ...boundary, context: [summary, retained] });
  expect(restored.map((message) => message.rawMessage)).toEqual([retained, undefined, communication.rawMessage, [nextTool]]);
  const steer = { ...user, id: "steer", createdAt: 5 };
  expect(restoreCompactedContext([old, user, steer, assistant], { ...boundary, context: [summary, retained] }).at(-1)).toBe(assistant);
  const displayOnly = { ...communication, rawMessage: undefined };
  expect(restoreCompactedContext([old, displayOnly, user, assistant], { throughMessageId: displayOnly.id, context: [summary] }).at(1)).toBe(user);
  expect(restoreCompactedContext([old, user, displayOnly], { throughMessageId: old.id, context: [summary] }).slice(1)).toEqual([user]);
  expect(assistant.rawMessage).toEqual([retained, nextTool]);
  expect(restoreCompactedContext([old], { ...boundary, context: [summary, retained] })).toEqual([old]);
});

test("automatic Pi compaction survives disposal before a fresh prompt without trusting retained usage", async () => {
  const provider = "qone-auto-compaction";
  const faux = fauxProvider({ provider, models: [{ id: "test-model", contextWindow: 100_000, maxTokens: 4_096 }] });
  const model = faux.getModel();
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  let db = openDb(":memory:");
  let snapshot: string | undefined;
  const sessionId = new SessionRepo(db).create().id;
  const key = `compaction:${sessionId}`;
  const messages = new MessageRepo(db);
  messages.add(sessionId, "user", "old request must not return ".repeat(4_000));
  messages.addAssistant(sessionId, "old answer");
  messages.add(sessionId, "user", "middle request ".repeat(6_000));
  messages.add(sessionId, "user", "recent request must survive");
  const recent = messages.addAssistant(sessionId, "recent response must survive", undefined, undefined, undefined, undefined, {
    ...fauxAssistantMessage("recent response must survive"), api: model.api, provider, model: model.id,
    usage: { ...fauxAssistantMessage("").usage, input: 90_000, totalTokens: 90_000 },
  });
  const requests: TranscriptContext[] = [];
  const events: AgentEvent[] = [];
  const summary = "checkpoint: keep the project requirements";
  faux.setResponses([summary, "first reply", "second reply"].map((text) => (context) => {
    requests.push(context);
    return fauxAssistantMessage(text);
  }));
  const readHistory = () => new MessageRepo(db).listBySession(sessionId);
  const readCheckpoint = () => new SettingsRepo(db).get<SessionCompactionCheckpoint>(key);
  const options = { cwd: process.cwd(), model: `${provider}/${model.id}` };
  let abortOnCompaction = false;
  const adapter = new PiAdapter((event) => {
    events.push(event);
    if (event.type === "compaction_start" && event.runId && abortOnCompaction) adapter.stop(event.runId);
  }, {
    onAutomaticCompaction: (id, runId, context) => {
      expect(id).toBe(sessionId);
      const boundary = automaticCompactionBoundary(readHistory(), runId, false, 0);
      if (!boundary) throw new Error("Missing compaction boundary");
      new SettingsRepo(db).set(key, { ...boundary, context } satisfies SessionCompactionCheckpoint);
    },
  }, undefined, (_id, runId) => restoreCompactedContext(readHistory().filter(row => row.runId !== runId).map(row => ({
    ...row, attachments: undefined, rawMessage: row.rawMessage ? JSON.parse(row.rawMessage) : undefined,
  })), readCheckpoint()));
  Object.assign(adapter, { modelRuntime: runtime });
  const addPrompt = (prompt: string) => {
    const runId = new RunRepo(db).create(sessionId).id;
    new MessageRepo(db).add(sessionId, "user", prompt, runId);
    return { ...options, runId };
  };
  try {
    const first = addPrompt("first new prompt");
    await adapter.run(sessionId, "first new prompt", first, () => {});
    new MessageRepo(db).addAssistant(sessionId, "first reply", first.runId);
    expect(readCheckpoint()?.throughMessageId).toBe(recent.id);
    snapshot = snapshotDb(db);
    const reopened = openDb(snapshot);
    closeDb(db);
    db = reopened;
    expect((await adapter.getContextUsage(sessionId, options.cwd, options.model)).tokens).toBeLessThan(30_000);
    await adapter.run(sessionId, "second new prompt", addPrompt("second new prompt"), () => {});
    expect(events.filter((event) => event.type === "compaction_end")).toHaveLength(1);
    expect(requests).toHaveLength(3);
    expect(JSON.stringify(requests[0]!.messages)).toContain("old request must not return");
    for (const [index, prompt] of ["first new prompt", "second new prompt"].entries()) {
      const text = JSON.stringify(requests[index + 1]!.messages);
      expect(text).toContain(summary);
      expect(text).toContain("recent response must survive");
      expect(text).not.toContain("old request must not return");
      expect(text.split(prompt)).toHaveLength(2);
    }
    const continued = JSON.stringify(requests[2]!.messages);
    expect(continued.split("first new prompt")).toHaveLength(2);
    expect(continued.split("first reply")).toHaveLength(2);

    const saved = readCheckpoint();
    const newer = new MessageRepo(db);
    newer.add(sessionId, "user", "another long request ".repeat(6_000));
    newer.add(sessionId, "user", "latest request");
    newer.addAssistant(sessionId, "latest answer", undefined, undefined, undefined, undefined, {
      ...fauxAssistantMessage("latest answer", { timestamp: Date.now() + 1 }), api: model.api, provider, model: model.id,
      usage: { ...fauxAssistantMessage("").usage, input: 90_000, totalTokens: 90_000 },
    });
    abortOnCompaction = true;
    faux.appendResponses([fauxAssistantMessage("cancelled run")]);
    await adapter.run(sessionId, "cancel this compaction", addPrompt("cancel this compaction"), () => {});
    const compactionEnds = events.filter(event => event.type === "compaction_end");
    expect(compactionEnds).toHaveLength(2);
    expect(compactionEnds.at(-1)?.payload).toMatchObject({ aborted: true });
    expect(readCheckpoint()).toEqual(saved);

    abortOnCompaction = false;
    faux.setResponses([
      fauxAssistantMessage("new checkpoint"),
      fauxAssistantMessage("", { stopReason: "error", errorMessage: "Invalid model input" }),
    ]);
    const runEvents: string[] = [];
    await expect(adapter.run(sessionId, "failing prompt", addPrompt("failing prompt"), (type) => runEvents.push(type)))
      .rejects.toThrow("Invalid model input");
    expect(events.filter(event => event.type === "compaction_end").at(-1)?.payload).toMatchObject({ aborted: false, result: { summary: "new checkpoint" } });
    expect(runEvents).not.toContain("agent.prompt_done");
  } finally {
    await adapter.disposeSession(sessionId);
    closeDb(db);
    if (snapshot) rmSync(dirname(snapshot), { recursive: true, force: true });
  }
});

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
    expect(entries.map((entry) => entry.type === "message" ? entry.message.role : entry.type)).toEqual(["compaction", "user"]);
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
      sessionManager: { getBranch: () => [] },
      messages: [summary],
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
        expect(tools).toContain("tool_search");
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
