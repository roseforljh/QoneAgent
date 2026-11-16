import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { closeDb, EventRepo, MessageRepo, openDb, RunRepo, SessionRepo, SettingsRepo, SubagentNotificationRepo, SubagentRunRepo, ToolCallRepo } from "@qone/database";
import { SequencedEventJournal } from "@qone/shared";
import type { AgentEvent } from "@qone/protocol";
import { handleRuntimeEvent, NOT_REPLAYED } from "../src/runtime-event-subscriber";
import { CompactionPositions } from "../src/compaction-position";

// Mirrors index.ts: the journal records every event, the subscriber decides
// which ones reach SQLite. A large tool result used to be written five times.
function harness() {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qone-event-hotpath-"));
  const db = openDb(path.join(directory, "agent.db"));
  const session = new SessionRepo(db).create("hot path");
  const run = new RunRepo(db).create(session.id);
  const journal = new SequencedEventJournal<AgentEvent>(0);
  const persisted: AgentEvent[] = [];
  const sent: unknown[] = [];
  const ctx = {
    messageRepo: new MessageRepo(db), runRepo: new RunRepo(db), subagentRunRepo: new SubagentRunRepo(db),
    toolCallRepo: new ToolCallRepo(db), settingsRepo: new SettingsRepo(db),
    assistantBuffers: new Map(), assistantStreamBuffers: new Map(), assistantPartsByRun: new Map(),
    assistantRawMessagesByRun: new Map(), assistantMessageSequenceByRun: new Map(), liveAssistantByRun: new Map(),
    subagentStreams: new Map(), activeSubagents: new Set(), subagentRunIds: new Set(), initialUserMessageSeen: new Set(),
    approvalRuns: new Map(), approvalToolCalls: new Map(), toolCallIds: new Map(),
    compactionPositions: new CompactionPositions(),
    send: (event: unknown) => { sent.push(event); }, emit: () => {}, flushEvents: () => {},
    touchSession: () => {}, sendMessages: () => {}, deliverSteer: () => {},
    queueEventPersistence: (event: AgentEvent) => { persisted.push(event); },
    runRequiresSubagentFinalization: () => false,
    subagentConfig: () => ({ runtime: { tokenBudget: 0 } }) as never,
    subagentController: () => undefined,
    subagentNotificationCoordinator: () => undefined,
    subagentPublisher: { publish: () => {}, patch: () => {}, append: () => {}, appendReasoning: () => {}, queueParts: () => {}, snapshot: () => ({}) } as never,
  };
  const emit = (type: string, payload: unknown) => {
    const replay = journal.record((sequence) => ({
      eventId: crypto.randomUUID(), sequence, type, sessionId: session.id, runId: run.id,
      timestamp: Date.now(), payload: type === "agent.completed" ? {} : payload, scope: "conversation" as const,
    }), !NOT_REPLAYED.has(type));
    const event = type === "agent.completed" ? { ...replay, payload } : replay;
    handleRuntimeEvent(ctx as never, { type, payload, sessionId: session.id, runId: run.id }, event, false);
    return event;
  };
  return { directory, db, session, run, journal, persisted, sent, emit, ctx, close: () => { closeDb(db); rmSync(directory, { recursive: true, force: true }); } };
}

describe("replay journal hot path", () => {
  test("a 4MB tool result survives canonical storage without redundant journal copies", () => {
    const h = harness();
    try {
      const big = "x".repeat(4 * 1024 * 1024);
      const message = { role: "toolResult", toolCallId: "call-1", content: big, details: { output: big } };
      for (const type of ["tool.started", "tool.updated", "tool.completed", "message.started", "message.completed", "turn_end", "turn.completed"]) {
        h.emit(type, { message, result: { content: big }, toolCallId: "call-1" });
      }
      expect(h.persisted).toEqual([]);
      // Store and reopen the same complete payload used in the live events.
      h.ctx.messageRepo.addAssistant(h.session.id, "answer", h.run.id, undefined, [], undefined, [message]);
      const call = h.ctx.toolCallRepo.start(h.run.id, "read", { path: "a" }, "call-1");
      h.ctx.toolCallRepo.finish(call.id, "success", { content: [{ type: "text", text: big }] });
      const reopened = openDb(path.join(h.directory, "agent.db"));
      try {
        const raw = JSON.parse(new MessageRepo(reopened).listBySession(h.session.id)[0]!.rawMessage!);
        expect(raw[0].content).toBe(big);
        const result = JSON.parse(new ToolCallRepo(reopened).listByRun(h.run.id)[0]!.resultSummary!);
        expect(result.content[0].text).toBe(big);
      } finally { closeDb(reopened); }
      // Lifecycle events that nothing else stores still persist.
      h.emit("agent.completed", { message: { role: "assistant", content: "done" } });
      h.emit("context.compacted", { id: "c1", throughMessageId: "m1" });
      expect(h.persisted.map((event) => event.type)).toEqual(["agent.completed", "context.compacted"]);
      // The terminal marker survives, without the assistant row's payload.
      expect(h.persisted[0]!.payload).toEqual({});
      expect(h.journal.replay()[0]!.payload).toEqual({});
      expect(h.sent.at(-2)).toMatchObject({ type: "agent.event", event: { payload: { message: { content: "done" } } } });
      expect(h.persisted[1]!.payload).toEqual({ id: "c1", throughMessageId: "m1" });
      // The UI still receives every event, including the ones not persisted.
      expect(h.sent).toHaveLength(9);
    } finally { h.close(); }
  });

  test("streamed tokens advance the journal cursor without a row per token", () => {
    const h = harness();
    try {
      for (let index = 0; index < 500; index++) h.emit("message.delta", { delta: "字" });
      expect(h.persisted).toEqual([]);
      expect(h.journal.next).toBe(500);
      // A restart seeds from the settings watermark, which must cover the
      // transient sequences or the renderer would see them again.
      h.ctx.settingsRepo.set("event.sequence", h.journal.next);
      const restarted = new SequencedEventJournal<AgentEvent>(h.ctx.settingsRepo.get<number>("event.sequence")!);
      expect(restarted.next).toBe(500);
      expect(h.journal.replay()).toEqual([]);
    } finally { h.close(); }
  });

  test("an initial user prompt with a restored child ledger has only one raw owner", () => {
    const h = harness();
    try {
      h.ctx.assistantPartsByRun.set(h.run.id, []);
      const raw = { role: "user", content: [{ type: "text", text: "[QONE_SUBAGENT_NOTIFICATION]\\nrestored child result\\nnew user task" }] };
      const row = h.ctx.messageRepo.add(h.session.id, "user", "new user task", h.run.id);
      h.emit("message.completed", { message: raw });
      expect(JSON.parse(h.ctx.messageRepo.listBySession(h.session.id).find(message => message.id === row.id)!.rawMessage!)).toEqual(raw);
      expect(h.ctx.assistantRawMessagesByRun.has(h.run.id)).toBe(false);
      const delivered = { role: "user", content: [{ type: "text", text: "[QONE_SUBAGENT_LEDGER]\\nnew child update" }] };
      h.emit("message.completed", { message: delivered });
      expect(h.ctx.assistantRawMessagesByRun.get(h.run.id)).toEqual([delivered]);
    } finally { h.close(); }
  });

  test("only server operations and terminal markers project from a child onto its owning conversation", () => {
    const h = harness();
    try {
      const child = h.ctx.runRepo.create(h.session.id);
      h.ctx.subagentRunRepo.create({ runId: child.id, parentSessionId: h.session.id, parentRunId: h.run.id, toolCallId: "dispatch", title: "worker", task: "inspect" });
      const tool = h.ctx.toolCallRepo.start(child.id, "server_exec", {}, "operation");
      const emit = (type: string, payload: unknown) => {
        const event: AgentEvent = { eventId: crypto.randomUUID(), sequence: 1, timestamp: Date.now(), sessionId: "child-execution", runId: child.id, scope: "subagent", type, payload };
        handleRuntimeEvent(h.ctx as never, event, event, true);
      };
      emit("message.delta", { delta: "private child output" });
      emit("tool.updated", { toolName: "read", update: "private local file" });
      expect(h.sent).toEqual([]);
      const snapshot = { content: [{ type: "text", text: "live output" }], details: { serverOperation: { serverId: "a", serverName: "Alpha" } } };
      emit("tool.updated", { toolName: "server_exec", toolCallId: "operation", parentToolCallId: "script", update: snapshot });
      expect(h.sent).toHaveLength(1);
      expect(h.sent[0]).toMatchObject({ type: "agent.event", event: { sessionId: h.session.id, sourceSubagentId: child.id, runId: child.id, payload: { update: snapshot, parentToolCallId: "script" } } });
      emit("agent.cancelled", {});
      expect(h.sent).toHaveLength(2);
      expect(h.ctx.toolCallRepo.listByRun(child.id).find(call => call.id === tool.id)!.status).toBe("cancelled");
    } finally { h.close(); }
  });

  test("NOT_REPLAYED keeps every type whose payload has its own table", () => {
    for (const type of ["message.completed", "tool.completed", "turn_end", "turn.completed", "context.usage", "message.started"]) {
      expect(NOT_REPLAYED.has(type)).toBe(true);
    }
    for (const type of ["context.compacted", "context.compaction.interrupted", "agent.completed", "approval.requested", "subagent.finished", "compaction_end"]) {
      expect(NOT_REPLAYED.has(type)).toBe(false);
    }
  });
});

describe("event table growth", () => {
  test("a long run's journal rows and bytes stay bounded, measured before and after the filter", () => {
    const h = harness();
    try {
      const repo = new EventRepo(h.db);
      const big = "y".repeat(64 * 1024);
      // Exactly what the bus produces for 40 turns of 50 tokens + one 64KB tool
      // result each, plus the terminal event.
      const produced: AgentEvent[] = [];
      for (let turn = 0; turn < 40; turn++) {
        for (let token = 0; token < 50; token++) {
          produced.push(h.journal.record((sequence) => ({
            eventId: crypto.randomUUID(), sequence, type: "message.delta", sessionId: h.session.id,
            runId: h.run.id, timestamp: Date.now(), payload: { delta: "t" }, scope: "conversation" as const,
          }), false));
        }
        for (const type of ["tool.started", "tool.completed", "message.started", "message.completed", "turn_end", "turn.completed"]) {
          produced.push(h.journal.record((sequence) => ({
            eventId: crypto.randomUUID(), sequence, type, sessionId: h.session.id,
            runId: h.run.id, timestamp: Date.now(), payload: { result: big }, scope: "conversation" as const,
          }), false));
        }
      }
      const durable = h.journal.record((sequence) => ({
        eventId: crypto.randomUUID(), sequence, type: "agent.completed", sessionId: h.session.id,
        runId: h.run.id, timestamp: Date.now(), payload: { message: { role: "assistant", content: big } }, scope: "conversation" as const,
      }), false);
      produced.push(durable);

      const before = JSON.stringify(produced).length;
      const after = produced.filter((event) => !NOT_REPLAYED.has(event.type));
      repo.addMany(after.map((event) => event.type === "agent.completed" ? { ...event, payload: {} } : event));
      const stored = repo.list();
      const storedBytes = JSON.stringify(stored).length;

      expect(produced).toHaveLength(40 * 56 + 1);
      expect(after.map((event) => event.type)).toEqual(["agent.completed"]);
      expect(stored.map((event) => event.type)).toEqual(["agent.completed"]);
      // Before: ~2400 events, ~15MB of payload. After: one marker row.
      expect(before).toBeGreaterThan(15_000_000);
      expect(storedBytes).toBeLessThan(2_000);
      expect(h.journal.next).toBe(40 * 56 + 1);
    } finally { h.close(); }
  });
});
