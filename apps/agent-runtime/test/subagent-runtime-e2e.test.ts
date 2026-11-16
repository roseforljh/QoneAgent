import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

test("real runtime keeps the parent working, exchanges agent messages, and gates finalization until the child is reviewed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-subagent-e2e-"));
  const marker = path.join(directory, "parent-independent.txt");
  await Bun.write(marker, "PARENT_INDEPENDENT_WORK_VERIFIED");
  let parentStep = 0, childStep = 0, childId = "";
  let finalParentInput: unknown[] = [], finalChildInput: unknown[] = [];
  let idleChildInput: unknown[] = [];
  let releaseChild!: () => void, childIsLive!: () => void, parentIsWaiting!: () => void;
  const parentWaiting = new Promise<void>(resolve => { parentIsWaiting = resolve; });
  const childMayFinish = new Promise<void>(resolve => { releaseChild = resolve; });
  const childLive = new Promise<void>(resolve => { childIsLive = resolve; });
  const observations: string[] = [], errors: string[] = [];
  const sse = (delta: object, reason = "stop") => new Response([
    `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "finish", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  const tool = (name: string, args: object) => sse({ role: "assistant", tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    try {
      const body = await request.json() as { messages: { role: string; content: unknown }[] };
      const users = body.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n");
      const transcript = JSON.stringify(body.messages);
      if (users.includes("<subagent-task")) {
        switch (childStep++) {
          case 0:
            await parentWaiting;
            return tool("message_parent", { message: "CHILD_INTERMEDIATE_FINDING" });
          case 1:
            observations.push("child-stream-open"); childIsLive();
            await childMayFinish;
            return sse({ role: "assistant", content: "Child is applying parent guidance." });
          case 2:
            expect(users).toContain("PARENT_GUIDANCE");
            finalChildInput = body.messages;
            observations.push("child-received-parent-message");
            return sse({ role: "assistant", content: "CHILD_FINAL_VERIFIED" });
          case 3:
            expect(body.messages.slice(0, finalChildInput.length)).toEqual(finalChildInput);
            expect(body.messages).toHaveLength(finalChildInput.length + 2);
            expect(JSON.stringify(body.messages.at(-2))).toContain("CHILD_FINAL_VERIFIED");
            expect(JSON.stringify(body.messages.at(-1))).toContain("FOLLOW_UP_AFTER_RESTART");
            observations.push("child-guidance-and-follow-up-restored");
            return tool("message_parent", { message: "IDLE_PARENT_MESSAGE" });
          case 4:
            idleChildInput = body.messages;
            return sse({ role: "assistant", content: "CHILD_IDLE_FOLLOW_UP_DONE" });
          case 5:
            expect(body.messages.slice(0, idleChildInput.length)).toEqual(idleChildInput);
            expect(body.messages).toHaveLength(idleChildInput.length + 2);
            expect(JSON.stringify(body.messages.at(-1))).toContain("SECOND_CHILD_FOLLOW_UP");
            observations.push("child-follow-up-exactly-once");
            return sse({ role: "assistant", content: "CHILD_SECOND_FOLLOW_UP_DONE" });
          default: throw new Error(`unexpected child step ${childStep}: ${transcript.slice(-1200)}`);
        }
      }
      switch (parentStep++) {
        case 0: return tool("dispatch_subagent", { title: "独立检查", task: "CHILD_E2E: send an intermediate finding, apply parent guidance, then return a verified result", reason: "The child checks its own task while the parent reads a different file", expectedResult: "CHILD_FINAL_VERIFIED", capability: "temporary" });
        case 1:
          childId = /runId=([a-f0-9-]{36})/.exec(transcript)?.[1] ?? "";
          expect(childId).not.toBe("");
          return tool("read", { path: marker });
        case 2:
          expect(transcript).toContain("PARENT_INDEPENDENT_WORK_VERIFIED");
          observations.push("parent-independent-work");
          return sse({ role: "assistant", content: "Parent independent work is done; collecting the required child result." });
        case 3:
          expect(transcript).toContain("CHILD_INTERMEDIATE_FINDING");
          observations.push("waiting-parent-woken-by-child");
          await childLive;
          return tool("control_subagent", { runId: childId, action: "steer", message: "PARENT_GUIDANCE: verify before finishing" });
        case 4:
          observations.push("parent-received-child-message");
          return tool("finalize_response", { resolvedSubagentRunIds: [childId] });
        case 5:
          expect(transcript).toContain('\\"ok\\":false');
          observations.push("premature-finalization-blocked");
          releaseChild();
          return tool("wait_subagent", { runId: childId, timeoutMs: 10000 });
        case 6:
          expect(transcript).toContain("CHILD_FINAL_VERIFIED");
          observations.push("parent-reviewed-child-result");
          return tool("finalize_response", { resolvedSubagentRunIds: [childId] });
        case 7:
          finalParentInput = body.messages;
          return sse({ role: "assistant", content: "PARENT_FINAL_AFTER_CHILD_REVIEW" });
        case 8:
          expect(body.messages.slice(0, finalParentInput.length)).toEqual(finalParentInput);
          expect(body.messages).toHaveLength(finalParentInput.length + 3);
          expect(JSON.stringify(body.messages.at(-3))).toContain("PARENT_FINAL_AFTER_CHILD_REVIEW");
          expect(JSON.stringify(body.messages.at(-2))).toContain("IDLE_PARENT_MESSAGE");
          expect(JSON.stringify(body.messages.at(-1))).toContain("CONTINUE_AFTER_RESTART");
          observations.push("exact-communication-order-restored");
          return sse({ role: "assistant", content: "RESTORED_ORDER_VERIFIED" });
        default: throw new Error(`unexpected parent step ${parentStep}: ${transcript.slice(-1200)}`);
      }
    } catch (error) { errors.push(String(error)); releaseChild(); childIsLive(); return new Response(String(error), { status: 500 }); }
  } });
  const database = path.join(directory, "agent.db");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("E2E", directory);
  const session = new SessionRepo(db).create("Main agent", workspace.id);
  new ModelConfigRepo(db).upsert({ provider: "subagent-e2e", model: "model", enabled: true, config: {
    apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, thinking: "none",
    contextWindow: 128000, maxTokens: 8192, input: ["text"], output: ["text"],
  } });
  closeDb(db);
  const spawn = () => Bun.spawn([Bun.which("bun")!, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, QONE_DATA_DIR: directory, QONE_DB: database, APPDATA: directory,
      QONE_LOG_DIR: path.join(directory, "logs"), QONE_PLUGINS_DIR: path.join(directory, "plugins") },
  });
  let child = spawn(), events: RuntimeEvent[] = [];
  const collect = (process: typeof child) => (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of process.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) {
        const value = JSON.parse(line);
        const batch = (Array.isArray(value) ? value : [value]) as RuntimeEvent[];
        events.push(...batch);
        if (batch.some(event => event.type === "agent.event" && event.event.type === "agent.waiting_subagents")) parentIsWaiting();
      }
    }
  })();
  let output = collect(child), stderr = new Response(child.stderr).text();
  const send = async (command: RuntimeCommand) => { child.stdin.write(JSON.stringify(command) + "\n"); await child.stdin.flush(); };
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
      if (errors.length || Date.now() > deadline) throw new Error(JSON.stringify({ errors, observations, parentStep, childStep, events: events.filter(event => event.type === "agent.event").slice(-10).map(event => event.type === "agent.event" ? event.event.type : event.type) }));
      await Bun.sleep(5);
    }
  };
  try {
    await send({ type: "secret.set", requestId: "key", key: "model.apiKey:subagent-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
    await send({ type: "agent.run", requestId: "start", sessionId: session.id, message: "PARENT_E2E: delegate an independent child and keep working", model: "subagent-e2e/model", permissionMode: "full" });
    await wait(() => events.some(event => event.type === "agent.event" && event.event.type === "agent.completed"));
    expect(errors).toEqual([]);
    expect(events.filter(event => event.type === "agent.event" && event.event.type === "agent.failed")).toEqual([]);
    expect(observations).toEqual(expect.arrayContaining(["parent-independent-work", "waiting-parent-woken-by-child", "parent-received-child-message", "child-received-parent-message", "premature-finalization-blocked", "parent-reviewed-child-result"]));
    const finished = events.find(event => event.type === "agent.event" && event.event.type === "agent.completed");
    expect(JSON.stringify(finished)).toContain("PARENT_FINAL_AFTER_CHILD_REVIEW");
    child.kill(); await child.exited; await output; await stderr;
    events = []; child = spawn(); output = collect(child); stderr = new Response(child.stderr).text();
    await send({ type: "session.snapshot", requestId: "restore", sessionId: session.id });
    await wait(() => events.some(event => event.type === "session.subagents"));
    const history = events.find(event => event.type === "session.messages");
    if (history?.type !== "session.messages") throw new Error("missing parent history");
    const notice = history.messages.find(message => message.communication?.fromId === childId);
    expect(notice?.content).toBe("CHILD_INTERMEDIATE_FINDING");
    expect(notice?.communication?.toTitle).toBe("Main agent");
    const agents = events.find(event => event.type === "session.subagents");
    if (agents?.type !== "session.subagents") throw new Error("missing child history");
    const run = agents.subagents.find(agent => agent.id === childId)!;
    expect(run.status).toBe("completed");
    expect(run.messages?.[0]?.internal).toBe(false);
    expect(run.messages?.[0]?.role).toBe("user");
    const savedParts = run.messages?.filter(message => message.role === "assistant").flatMap(message => message.parts ?? []);
    expect(savedParts).toEqual(run.parts);
    expect(run.completionAcknowledged).toBe(true);
    expect(run.messages?.some(message => message.communication?.toId === childId && message.content.includes("PARENT_GUIDANCE"))).toBe(true);
    expect(run.messages?.some(message => message.communication?.fromId === childId && message.content === "CHILD_INTERMEDIATE_FINDING")).toBe(true);
    await send({ type: "secret.set", requestId: "restore-key", key: "model.apiKey:subagent-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
    await send({ type: "subagent.control", requestId: "child-follow-up", runId: childId, action: "follow_up", message: "FOLLOW_UP_AFTER_RESTART" });
    await wait(() => events.some(event => event.type === "subagent.controlled" && event.requestId === "child-follow-up"));
    expect(observations).toContain("child-guidance-and-follow-up-restored");
    await send({ type: "subagent.control", requestId: "child-follow-up-again", runId: childId, action: "follow_up", message: "SECOND_CHILD_FOLLOW_UP" });
    await wait(() => events.some(event => event.type === "subagent.controlled" && event.requestId === "child-follow-up-again"));
    expect(observations).toContain("child-follow-up-exactly-once");
    // Restart again so the idle-parent message cannot be supplied by a live map.
    child.kill(); await child.exited; await output; await stderr;
    events = []; child = spawn(); output = collect(child); stderr = new Response(child.stderr).text();
    await send({ type: "secret.set", requestId: "idle-restore-key", key: "model.apiKey:subagent-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
    await send({ type: "agent.run", requestId: "continue", sessionId: session.id, message: "CONTINUE_AFTER_RESTART", model: "subagent-e2e/model", permissionMode: "full" });
    await wait(() => events.some(event => event.type === "agent.event" && event.event.type === "agent.completed"));
    expect(observations).toContain("exact-communication-order-restored");
  } finally {
    releaseChild(); childIsLive(); parentIsWaiting(); child.kill(); await child.exited; await output; await stderr;
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 60000);
