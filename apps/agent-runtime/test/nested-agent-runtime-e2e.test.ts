import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ConfigFile, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

// Real runtime, SQLite restart and local SSE provider. A single scheduler permit
// must support a parent waiting for a nested child, without losing either chat.
test("nested agents preserve live and idle communication exactly across runtime restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-nested-e2e-"));
  let rootStep = 0, outerStep = 0, leafStep = 0, outerId = "", leafId = "";
  let finalOuterInput: unknown[] = [], finalLeafInput: unknown[] = [], continuedOuterInput: unknown[] = [];
  const errors: string[] = [], observations: string[] = [];
  const sse = (delta: object, reason = "stop") => new Response([
    `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "finish", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  const text = (content: string) => sse({ role: "assistant", content });
  const tool = (name: string, args: object) => sse({ role: "assistant", tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
  const delegate = (title: string, task: string) => tool("dispatch_subagent", { title, task, capability: "temporary", reason: "Separate independent checks", expectedResult: `${title}_VERIFIED` });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    try {
      const body = await request.json() as { messages: { role: string; content: unknown }[] };
      const users = body.messages.filter(message => message.role === "user").map(message => JSON.stringify(message.content)).join("\n");
      const transcript = JSON.stringify(body.messages);
      if (users.includes("LEAF_TASK")) {
        switch (leafStep++) {
          case 0: return tool("message_parent", { message: "NESTED_LIVE_MESSAGE" });
          case 1:
            finalLeafInput = body.messages;
            return text("LEAF_VERIFIED");
          case 2:
            expect(body.messages.slice(0, finalLeafInput.length)).toEqual(finalLeafInput);
            expect(body.messages).toHaveLength(finalLeafInput.length + 2);
            expect(JSON.stringify(body.messages.at(-1))).toContain("LEAF_FOLLOW_UP");
            return tool("message_parent", { message: "NESTED_IDLE_MESSAGE" });
          case 3: return text("LEAF_FOLLOW_UP_VERIFIED");
          default: throw new Error(`unexpected leaf step ${leafStep}`);
        }
      }
      if (users.includes("OUTER_TASK")) {
        switch (outerStep++) {
          case 0: return delegate("Leaf", "LEAF_TASK: independently check a different file and send a progress message");
          case 1:
            leafId = /runId=([a-f0-9-]{36})/.exec(transcript)?.[1] ?? "";
            expect(leafId).not.toBe("");
            return text("Outer independent work done; waiting for leaf.");
          case 2:
            expect(users).toContain("NESTED_LIVE_MESSAGE");
            observations.push("nested-live-delivered");
            return tool("wait_subagent", { runId: leafId, timeoutMs: 10000 });
          case 3:
            expect(transcript).toContain("LEAF_VERIFIED");
            return tool("finalize_response", { resolvedSubagentRunIds: [leafId] });
          case 4:
            finalOuterInput = body.messages;
            return text("OUTER_VERIFIED");
          case 5:
            expect(body.messages.slice(0, finalOuterInput.length)).toEqual(finalOuterInput);
            expect(body.messages).toHaveLength(finalOuterInput.length + 3);
            expect(JSON.stringify(body.messages.at(-3))).toContain("OUTER_VERIFIED");
            expect(JSON.stringify(body.messages.at(-2))).toContain("NESTED_IDLE_MESSAGE");
            expect(JSON.stringify(body.messages.at(-1))).toContain("OUTER_FOLLOW_UP");
            observations.push("nested-live-idle-restored");
            return tool("finalize_response", { resolvedSubagentRunIds: [leafId] });
          case 6:
            continuedOuterInput = body.messages;
            return text("OUTER_CONTINUED");
          case 7:
            expect(body.messages.slice(0, continuedOuterInput.length)).toEqual(continuedOuterInput);
            expect(body.messages).toHaveLength(continuedOuterInput.length + 2);
            expect(JSON.stringify(body.messages.at(-1))).toContain("OUTER_AGAIN");
            observations.push("nested-restored-once");
            return text("OUTER_DONE");
          default: throw new Error(`unexpected outer step ${outerStep}`);
        }
      }
      switch (rootStep++) {
        case 0: return delegate("Outer", "OUTER_TASK: independently check, delegate another check and review its result");
        case 1:
          outerId = /runId=([a-f0-9-]{36})/.exec(transcript)?.[1] ?? "";
          expect(outerId).not.toBe("");
          return tool("wait_subagent", { runId: outerId, timeoutMs: 10000 });
        case 2:
          expect(transcript).toContain("OUTER_VERIFIED");
          return tool("finalize_response", { resolvedSubagentRunIds: [outerId, leafId] });
        case 3: return text("ROOT_VERIFIED");
        default: throw new Error(`unexpected root step ${rootStep}`);
      }
    } catch (error) { errors.push(String(error)); return new Response(String(error), { status: 500 }); }
  } });
  const database = path.join(directory, "agent.db");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("Nested E2E", directory);
  const session = new SessionRepo(db).create("Nested root", workspace.id);
  new ModelConfigRepo(new ConfigFile(path.join(directory, "settings.json"))).upsert({ provider: "nested-e2e", model: "model", enabled: true, config: {
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
        events.push(...(Array.isArray(value) ? value : [value]));
      }
    }
  })();
  let output = collect(child), stderr = new Response(child.stderr).text();
  const send = async (command: RuntimeCommand) => { child.stdin.write(JSON.stringify(command) + "\n"); await child.stdin.flush(); };
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
      const failure = events.find(event => event.type === "error");
      if (errors.length || failure || Date.now() > deadline) throw new Error(JSON.stringify({ errors, failure, rootStep, outerStep, leafStep, events: events.slice(-3) }));
      await Bun.sleep(5);
    }
  };
  const key = async () => {
    await send({ type: "secret.set", requestId: crypto.randomUUID(), key: "model.apiKey:nested-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
  };
  const restart = async () => {
    child.kill(); await child.exited; await output; await stderr;
    events = []; child = spawn(); output = collect(child); stderr = new Response(child.stderr).text();
    await key();
  };
  const followUp = async (runId: string, message: string) => {
    await send({ type: "subagent.control", requestId: message, runId, action: "follow_up", message });
    await wait(() => events.some(event => event.type === "subagent.controlled" && event.requestId === message));
  };
  try {
    await key();
    await send({ type: "subagent.sync", requestId: "single-permit", config: { profiles: [], routing: {}, runtime: {
      temporaryModelId: "", maxConcurrent: 1, timeoutMs: 30000, tokenBudget: 0,
      contextMode: "task-only", contextMessages: 0, allowNested: true, maxDepth: 3, workflowMaxSteps: 32, backgroundEnabled: true,
    }, updatedAt: 1 } });
    await wait(() => events.some(event => event.type === "subagent.list" && event.requestId === "single-permit"));
    await send({ type: "agent.run", requestId: "nested", sessionId: session.id, message: "ROOT_TASK", model: "nested-e2e/model", permissionMode: "full" });
    await wait(() => events.some(event => event.type === "agent.event" && event.event.type === "agent.completed"));
    expect(observations).toContain("nested-live-delivered");
    await restart();
    await followUp(leafId, "LEAF_FOLLOW_UP");
    await restart();
    await followUp(outerId, "OUTER_FOLLOW_UP");
    await followUp(outerId, "OUTER_AGAIN");
    expect(observations).toEqual(["nested-live-delivered", "nested-live-idle-restored", "nested-restored-once"]);
    expect(errors).toEqual([]);
    expect(events.filter(event => event.type === "error")).toEqual([]);
  } finally {
    child.kill(); await child.exited; await output; await stderr; server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 60000);
