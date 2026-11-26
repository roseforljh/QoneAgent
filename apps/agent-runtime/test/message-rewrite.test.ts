import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, EventRepo, GoalRepo, MessageRepo, openDb, RunRepo, SessionRepo, ToolCallRepo, TurnRepo } from "@qone/database";
import { decodeCommand, type RuntimeEvent } from "@qone/protocol";

describe("editing and retrying a user turn", () => {
  test("removes that turn and later model context, runs, tools, and replay events", () => {
    const db = openDb(":memory:");
    try {
      const session = new SessionRepo(db).create();
      const messages = new MessageRepo(db);
      const runs = new RunRepo(db);
      const tools = new ToolCallRepo(db);
      const turns = new TurnRepo(db);
      const events = new EventRepo(db);
      const firstRun = runs.create(session.id);
      const firstUser = messages.add(session.id, "user", "first", firstRun.id);
      messages.addAssistant(session.id, "first answer", firstRun.id);
      const firstEvent = { eventId: crypto.randomUUID(), sessionId: session.id, runId: firstRun.id, sequence: 0, type: "agent.completed", timestamp: Date.now(), payload: {} };
      events.add(firstEvent);
      const secondRun = runs.create(session.id);
      const secondUser = messages.add(session.id, "user", "second", secondRun.id);
      messages.addAssistant(session.id, "old answer", secondRun.id);
      turns.create(secondRun.id);
      tools.start(secondRun.id, "read_file");
      events.add({ eventId: crypto.randomUUID(), sessionId: session.id, runId: secondRun.id, sequence: 1, type: "agent.completed", timestamp: Date.now(), payload: {} });
      const thirdRun = runs.create(session.id);
      messages.add(session.id, "user", "third", thirdRun.id);
      messages.addAssistant(session.id, "third answer", thirdRun.id);
      events.add({ eventId: crypto.randomUUID(), sessionId: session.id, runId: thirdRun.id, sequence: 2, type: "agent.completed", timestamp: Date.now(), payload: {} });

      expect(messages.truncateFrom(session.id, secondUser.id)).toEqual([secondRun.id, thirdRun.id]);
      expect(messages.listBySession(session.id).map((message) => message.content)).toEqual(["first", "first answer"]);
      expect(runs.listBySession(session.id).map((run) => run.id)).toEqual([firstRun.id]);
      expect(tools.listBySession(session.id)).toEqual([]);
      expect(turns.listByRun(secondRun.id)).toEqual([]);
      expect(events.list().map((event) => event.eventId)).toEqual([firstEvent.eventId]);
      expect(() => messages.truncateFrom(session.id, secondUser.id)).toThrow();
      expect(messages.listBySession(session.id)[0]?.id).toBe(firstUser.id);
    } finally {
      closeDb(db);
    }
  });

  test("session.truncate genuinely removes the turn, clears its goal kickoff, and broadcasts one refreshed batch", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "qone-truncate-test-"));
    const dbPath = path.join(directory, "test.db");
    const db = openDb(dbPath);
    const session = new SessionRepo(db).create("truncate");
    const runs = new RunRepo(db);
    const messages = new MessageRepo(db);
    const goals = new GoalRepo(db);
    const firstRun = runs.create(session.id);
    messages.add(session.id, "user", "keep me", firstRun.id);
    messages.addAssistant(session.id, "kept reply", firstRun.id);
    runs.finish(firstRun.id, "completed");

    const goal = goals.create(session.id, "remove this goal");
    const secondRun = runs.create(session.id, { origin: "goal_kickoff", goalId: goal.id, goalEpoch: goal.epoch });
    const targetUser = messages.add(session.id, "user", "remove this goal", secondRun.id, undefined, undefined, undefined, undefined, goal.id);
    messages.addAssistant(session.id, "goal reply", secondRun.id, undefined, undefined, goal.id);
    runs.finish(secondRun.id, "completed");
    closeDb(db);

    const command = { type: "session.truncate" as const, requestId: "truncate-req", sessionId: session.id, messageId: targetUser.id };
    expect(decodeCommand(JSON.stringify(command))).toEqual(command);

    const proc = Bun.spawn([Bun.which("bun")!, path.resolve(import.meta.dir, "../src/index.ts")], {
      stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...Bun.env, QONE_DB: dbPath, QONE_DATA_DIR: directory, APPDATA: directory, HOME: directory },
    });
    const reader = proc.stdout.getReader();
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      proc.stdin.write(`${JSON.stringify(command)}\n`);
      proc.stdin.flush();
      const batch = await Promise.race([
        (async () => {
          let buffer = "";
          const decoder = new TextDecoder();
          while (true) {
            const { value, done } = await reader.read();
            if (done) throw new Error(`Sidecar ended before truncate: ${await new Response(proc.stderr).text()}`);
            buffer += decoder.decode(value, { stream: true });
            let end;
            while ((end = buffer.indexOf("\n")) >= 0) {
              const line = buffer.slice(0, end);
              buffer = buffer.slice(end + 1);
              const parsed = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
              if (!Array.isArray(parsed)) {
                if (parsed.type === "error") throw new Error(parsed.message);
                continue;
              }
              return parsed;
            }
          }
        })(),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("session.truncate timed out")), 10_000); }),
      ]);

      expect(batch.map((event) => event.type)).toEqual([
        "session.messages",
        "goal.cleared",
        "session.runs",
        "session.toolCalls",
        "session.subagents",
        "session.subagentNotifications",
        "artifact.list",
        "pong",
      ]);
      const history = batch[0]!;
      if (history.type !== "session.messages") throw new Error("Missing session.messages");
      expect(history.requestId).toBeUndefined();
      expect(history.messages.map((m) => m.content)).toEqual(["keep me", "kept reply"]);
      const pong = batch.at(-1)!;
      expect(pong).toEqual({ type: "pong", requestId: command.requestId });

      // 确认数据库已真实持久化截断结果与目标清理
      const verifyDb = openDb(dbPath);
      try {
        expect(new MessageRepo(verifyDb).listBySession(session.id).map((m) => m.content)).toEqual(["keep me", "kept reply"]);
        expect(new GoalRepo(verifyDb).getBySession(session.id)).toBeUndefined();
      } finally {
        closeDb(verifyDb);
      }
    } finally {
      if (timer) clearTimeout(timer);
      proc.kill();
      await proc.exited;
      await reader.cancel();
      for (let attempt = 0; attempt < 40; attempt++) {
        try { rmSync(directory, { recursive: true, force: true }); break; }
        catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
      }
    }
  }, 15_000);
});
