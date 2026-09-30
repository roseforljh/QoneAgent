import { expect, test } from "bun:test";
import { closeDb, MessageRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { MessageAttachmentInfo, RuntimeEvent } from "@qone/protocol";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

test("runtime resend merges persisted identical user turns and preserves distinct inputs", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "qone-repeat-run-"));
  const dbPath = path.join(sandbox, "agent.db");
  const db = openDb(dbPath);
  const workspace = new WorkspaceRepo(db).upsert("test", sandbox);
  const session = new SessionRepo(db).create("test", workspace.id);
  const messages = new MessageRepo(db);
  const attachment: MessageAttachmentInfo = { type: "file", name: "note.txt", mimeType: "text/plain", data: "data:text/plain;base64,YQ==" };
  messages.add(session.id, "user", "same", undefined, undefined, "old-1", [attachment]);
  messages.add(session.id, "user", "same", undefined, undefined, "old-2", [attachment]);
  const answered = new SessionRepo(db).create("answered", workspace.id);
  messages.add(answered.id, "user", "same");
  messages.addAssistant(answered.id, "previous answer");
  closeDb(db);

  const process = Bun.spawn([Bun.which("bun")!, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "ignore",
    env: { ...Bun.env, APPDATA: sandbox, QONE_DB: dbPath, QONE_LOG_DIR: path.join(sandbox, "logs"), QONE_PLUGINS_DIR: path.join(sandbox, "plugins") },
  });
  const events: RuntimeEvent[] = [];
  const output = (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of process.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) events.push(JSON.parse(line));
    }
  })();
  const waitFor = async (predicate: (event: RuntimeEvent) => boolean) => {
    const deadline = Date.now() + 8_000;
    while (Date.now() < deadline) {
      const match = events.find(predicate);
      if (match) return match;
      await Bun.sleep(10);
    }
    throw new Error(`runtime response timed out: ${JSON.stringify(events)}`);
  };
  const run = async (sessionId: string, messageId: string, attachments?: MessageAttachmentInfo[]) => {
    const start = events.length;
    process.stdin.write(JSON.stringify({ type: "agent.run", requestId: messageId, sessionId, messageId, message: "same", attachments, model: "__qone_test_missing__/none" }) + "\n");
    await process.stdin.flush();
    await waitFor(event => events.indexOf(event) >= start && event.type === "agent.event" && event.event.sessionId === sessionId && event.event.type === "agent.failed");
  };
  const history = async (sessionId: string) => {
    const start = events.length;
    process.stdin.write(JSON.stringify({ type: "session.messages", requestId: crypto.randomUUID(), sessionId }) + "\n");
    await process.stdin.flush();
    const result = await waitFor(event => events.indexOf(event) >= start && event.type === "session.messages" && event.sessionId === sessionId);
    if (result.type !== "session.messages") throw new Error("unexpected response");
    return result.messages;
  };
  try {
    await run(session.id, "retry-1", [attachment]);
    expect((await history(session.id)).map(message => message.id)).toEqual(["retry-1"]);
    await run(session.id, "retry-2", [attachment]);
    expect((await history(session.id)).map(message => message.id)).toEqual(["retry-2"]);
    const changed = { ...attachment, data: "data:text/plain;base64,Yg==" };
    await run(session.id, "different-file", [changed]);
    expect((await history(session.id)).map(message => message.id)).toEqual(["retry-2", "different-file"]);
    await run(answered.id, "new-turn");
    expect((await history(answered.id)).map(message => message.content)).toEqual(["same", "previous answer", "same"]);
  } finally {
    process.kill();
    await process.exited;
    await output;
    await rm(sandbox, { recursive: true, force: true });
  }
}, 20_000);
