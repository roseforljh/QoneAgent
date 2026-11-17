import { expect, test } from "bun:test";
import { DatabaseSync as Database } from "node:sqlite";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, MessageRepo, openDb, RunRepo, SessionRepo, SubagentRunRepo } from "../src/index";
import type { AgentCommunicationInfo } from "@qone/protocol";

test("existing databases add agent communication without losing messages and preserve it across reopen", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-agent-communication-"));
  const database = path.join(directory, "agent.db");
  const legacy = new Database(database);
  const migrations = path.resolve(import.meta.dir, "../drizzle");
  for (const file of (await readdir(migrations)).filter(file => file.endsWith(".sql") && file < "0008_").sort()) {
    legacy.exec(await Bun.file(path.join(migrations, file)).text());
  }
  legacy.exec("INSERT INTO sessions(id,title,created_at,updated_at,last_user_message_at) VALUES ('parent','Conversation',1,1,1)");
  legacy.exec("INSERT INTO messages(id,session_id,role,content,created_at,updated_at) VALUES ('old','parent','user','keep original history',1,1)");
  legacy.close();
  let db: ReturnType<typeof openDb> | undefined;
  try {
    db = openDb(database);
    const runs = new RunRepo(db);
    const parent = runs.create("parent");
    const child = runs.create("parent");
    const subagents = new SubagentRunRepo(db);
    subagents.create({ runId: child.id, parentSessionId: "parent", parentRunId: parent.id, title: "Review", task: "Check", toolCallId: "dispatch" });
    const communication: AgentCommunicationInfo = { fromId: child.id, fromTitle: "Review", toId: parent.id, toTitle: "Main" };
    new MessageRepo(db).add("parent", "user", "progress", parent.id, undefined, undefined, undefined, undefined, undefined, undefined, undefined, communication);
    subagents.appendMessage(child.id, "user", "progress", undefined, { role: "user", content: "progress" }, communication);
    closeDb(db); db = openDb(database);
    const messages = new MessageRepo(db).listBySession("parent");
    expect(messages).toHaveLength(2);
    expect(messages[0]!.content).toBe("keep original history");
    expect(messages[0]!.communication).toBeNull();
    expect(JSON.parse(messages[1]!.communication!)).toEqual(communication);
    const transcript = new SubagentRunRepo(db).listMessages(child.id);
    expect(transcript).toHaveLength(1);
    expect(JSON.parse(transcript[0]!.communication!)).toEqual(communication);
    expect(JSON.parse(transcript[0]!.rawMessage!)).toEqual({ role: "user", content: "progress" });
    expect(new SessionRepo(db).get("parent")?.title).toBe("Conversation");
  } finally {
    if (db) closeDb(db);
    await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
});
