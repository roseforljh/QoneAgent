import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo, SubagentRunRepo } from "@qone/database";
import { decodeCommand, type RuntimeEvent } from "@qone/protocol";

test("a real sidecar returns all conversation state in one ordered stdout batch and restores child history across restart", async () => {
  const directory = mkdtempSync(path.join(tmpdir(), "qone-snapshot-test-"));
  const dbPath = path.join(directory, "test.db");
  const db = openDb(dbPath);
  const session = new SessionRepo(db).create("snapshot");
  const other = new SessionRepo(db).create("other");
  const runs = new RunRepo(db), messages = new MessageRepo(db), children = new SubagentRunRepo(db);
  const parent = runs.create(session.id), child = runs.create(session.id);
  messages.add(session.id, "user", "parent input", parent.id);
  messages.add(other.id, "user", "other input");
  children.create({ runId: child.id, parentSessionId: session.id, parentRunId: parent.id, toolCallId: "dispatch",
    executionSessionId: `${session.id}::subagent::${child.id}`, title: "worker", task: "child task" });
  const parts = [{ type: "text" as const, text: "child answer", messageSequence: 1 }];
  children.appendMessage(child.id, "user", "child task"); children.appendMessage(child.id, "assistant", "child answer", parts);
  children.save(child.id, "child answer", parts); runs.finish(child.id, "completed"); runs.finish(parent.id, "completed");
  closeDb(db);
  const command = { type: "session.snapshot" as const, requestId: "snapshot-request", sessionId: session.id };
  expect(decodeCommand(JSON.stringify(command))).toEqual(command);
  expect(decodeCommand(JSON.stringify({ ...command, sessionId: "" }))).toBeNull();
  const process = Bun.spawn([Bun.which("bun")!, path.resolve(import.meta.dir, "../src/index.ts")], {
    stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, QONE_DB: dbPath, QONE_DATA_DIR: directory, APPDATA: directory, HOME: directory },
  });
  const reader = process.stdout.getReader();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    process.stdin.write(`${JSON.stringify(command)}\n`); process.stdin.flush();
    const batch = await Promise.race([
      (async () => {
        let buffer = "";
        const decoder = new TextDecoder();
        while (true) {
          const { value, done } = await reader.read();
          if (done) throw new Error(`Sidecar ended before snapshot: ${await new Response(process.stderr).text()}`);
          buffer += decoder.decode(value, { stream: true });
          let end;
          while ((end = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
            const result = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
            if (!Array.isArray(result)) {
              if (result.type === "error") throw new Error(result.message);
              continue;
            }
            return result;
          }
        }
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error("Sidecar snapshot timed out")), 10_000); }),
    ]);
    expect(batch.map((event) => event.type)).toEqual(["session.messages", "goal.current", "session.queue", "session.toolCalls", "session.runs", "session.subagents", "session.subagentNotifications", "artifact.list"]);
    const history = batch.find((event) => event.type === "session.messages")!;
    expect(history.type).toBe("session.messages");
    if (history.type !== "session.messages") throw new Error("Missing history");
    expect(history.requestId).toBe(command.requestId); expect(history.sessionId).toBe(session.id);
    expect(history.messages.map((message) => message.content)).toEqual(["parent input"]);
    const subagents = batch.find((event) => event.type === "session.subagents")!;
    if (subagents.type !== "session.subagents") throw new Error("Missing children");
    expect(subagents.subagents).toHaveLength(1);
    expect(subagents.subagents[0]!.messages!.map((message) => message.content)).toEqual(["child task", "child answer"]);
    expect(subagents.subagents[0]!.parts).toEqual(parts);
    expect(subagents.subagents[0]!.status).toBe("completed");
    expect(subagents.subagents[0]!.revision).toBe(1);
    expect(typeof subagents.subagents[0]!.revisionEpoch).toBe("string");
  } finally {
    if (timer) clearTimeout(timer);
    process.kill(); await process.exited; await reader.cancel();
    const resolved = path.resolve(directory);
    if (path.dirname(resolved) !== path.resolve(tmpdir()) || !path.basename(resolved).startsWith("qone-snapshot-test-")) throw new Error("Unsafe test cleanup path");
    rmSync(resolved, { recursive: true, force: true });
  }
}, 15_000);
