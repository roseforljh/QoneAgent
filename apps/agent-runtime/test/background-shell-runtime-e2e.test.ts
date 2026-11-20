import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ConfigFile, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

test("real runtime returns a background command's result to an idle and to a running conversation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-background-e2e-"));
  let step = 0;
  const errors: string[] = [];
  const sse = (delta: object, reason = "stop") => new Response([
    `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`,
    `data: ${JSON.stringify({ id: "finish", object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta: {}, finish_reason: reason }] })}\n\n`,
    "data: [DONE]\n\n",
  ].join(""), { headers: { "Content-Type": "text/event-stream" } });
  const tool = (name: string, args: object) => sse({ role: "assistant", tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
  const say = (content: string) => sse({ role: "assistant", content });
  const count = (text: string, value: string) => text.split(value).length - 1;
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    try {
      const body = await request.json() as { messages: { role: string; content: unknown }[] };
      const transcript = JSON.stringify(body.messages);
      switch (step++) {
        case 0: return tool("powershell", { command: "Start-Sleep -Milliseconds 1500; 'IDLE_' + 'RESULT_OK'", background: true });
        case 1:
          expect(transcript).toContain("jobId=");
          return say("TURN_ONE_ENDED");
        case 2:
          // No one typed: the finished command itself started this turn.
          expect(transcript).toContain("[QONE_BACKGROUND_SHELL]");
          expect(transcript).toContain("IDLE_RESULT_OK");
          return say("WOKEN_BY_RESULT");
        case 3: return tool("codemode", { code: `return await tools.powershell({ command: "Start-Sleep -Milliseconds 800; 'LIVE_' + 'RESULT_OK'", background: true });` });
        case 4: return tool("powershell", { command: "Start-Sleep -Seconds 4; 'FOREGROUND_DONE'" });
        case 5:
          expect(transcript).toContain("FOREGROUND_DONE");
          expect(transcript).toContain("LIVE_RESULT_OK");
          return say("LIVE_RESULT_SEEN");
        case 6: return tool("powershell", { command: "'STOP_' + 'ME'; Start-Sleep -Seconds 60", background: true });
        case 7: return say("LEFT_RUNNING");
        case 8:
          // Rebuilt from SQLite: each result is replayed exactly once, in order.
          expect(count(transcript, "IDLE_RESULT_OK")).toBe(1);
          expect(count(transcript, "LIVE_RESULT_OK")).toBe(1);
          expect(transcript.indexOf("IDLE_RESULT_OK")).toBeLessThan(transcript.indexOf("WOKEN_BY_RESULT"));
          expect(transcript.indexOf("LIVE_RESULT_OK")).toBeLessThan(transcript.indexOf("LIVE_RESULT_SEEN"));
          return say("RESTORED_OK");
        default: throw new Error(`unexpected step ${step}: ${transcript.slice(-1200)}`);
      }
    } catch (error) { errors.push(String(error)); return new Response(String(error), { status: 500 }); }
  } });
  const database = path.join(directory, "agent.db");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("E2E", directory);
  const session = new SessionRepo(db).create("Main agent", workspace.id);
  new ModelConfigRepo(new ConfigFile(path.join(directory, "settings.json"))).upsert({ provider: "background-e2e", model: "model", enabled: true, config: {
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
        events.push(...(Array.isArray(value) ? value : [value]) as RuntimeEvent[]);
      }
    }
  })();
  let output = collect(child), stderr = new Response(child.stderr).text();
  const send = async (command: RuntimeCommand) => { child.stdin.write(JSON.stringify(command) + "\n"); await child.stdin.flush(); };
  const completed = () => events.filter(event => event.type === "agent.event" && event.event.type === "agent.completed");
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 30000;
    while (!predicate()) {
      if (errors.length || Date.now() > deadline) throw new Error(JSON.stringify({ errors, step, events: events.filter(event => event.type === "agent.event").slice(-10).map(event => event.type === "agent.event" ? event.event.type : event.type) }));
      await Bun.sleep(10);
    }
  };
  const run = (requestId: string, message: string) => send({ type: "agent.run", requestId, sessionId: session.id, message, model: "background-e2e/model", permissionMode: "full" });
  try {
    await send({ type: "secret.set", requestId: "key", key: "model.apiKey:background-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
    await run("start", "BUILD_IN_BACKGROUND");
    await wait(() => completed().length >= 1);
    expect(step).toBe(2);
    await wait(() => completed().length >= 2);
    expect(JSON.stringify(completed()[1])).toContain("WOKEN_BY_RESULT");

    await run("live", "LIVE_CASE");
    await wait(() => completed().length >= 3);
    expect(JSON.stringify(completed()[2])).toContain("LIVE_RESULT_SEEN");
    await Bun.sleep(1500);
    expect(completed()).toHaveLength(3);
    const jobUpdates = events.flatMap(event => event.type === "background-shell.job" ? [event.job] : []);
    expect(jobUpdates.filter(job => job.status === "exited").map(job => job.exitCode)).toEqual([0, 0]);
    expect(jobUpdates.at(-1)?.output).toContain("LIVE_RESULT_OK");

    // The user stops a command the turn left running: no result is delivered and no turn is woken.
    await run("leave-running", "LEAVE_IT_RUNNING");
    await wait(() => completed().length >= 4);
    const running = events.flatMap(event => event.type === "background-shell.job" && event.job.status === "running" && event.job.command.includes("STOP_") ? [event.job] : [])[0]!;
    await wait(() => events.some(event => event.type === "background-shell.job" && event.job.id === running.id && event.job.output.includes("STOP_ME")));
    await send({ type: "background-shell.stop", requestId: "stop", jobId: running.id });
    await wait(() => events.some(event => event.type === "pong" && event.requestId === "stop"));
    expect(events.filter(event => event.type === "background-shell.job" && event.job.id === running.id).at(-1)).toMatchObject({ job: { status: "stopped" } });
    await Bun.sleep(1500);
    expect(completed()).toHaveLength(4);
    expect(events.filter(event => event.type === "agent.event" && event.event.type === "agent.failed")).toEqual([]);

    child.kill(); await child.exited; await output; await stderr;
    events = []; child = spawn(); output = collect(child); stderr = new Response(child.stderr).text();
    await send({ type: "session.snapshot", requestId: "restore", sessionId: session.id });
    await wait(() => events.some(event => event.type === "background-shell.jobs") && events.some(event => event.type === "session.toolCalls"));
    // The call trace keeps the job link across reloads, even though live output is no longer tracked.
    expect(events.find(event => event.type === "background-shell.jobs")).toMatchObject({ jobs: [] });
    const trace = events.find(event => event.type === "session.toolCalls");
    if (trace?.type !== "session.toolCalls") throw new Error("missing tool calls");
    const jobLinks = trace.toolCalls.flatMap(call => {
      const result = JSON.parse(call.resultSummary ?? "null");
      return result?.details?.jobId ? [{ call, jobId: result.details.jobId }] : [];
    });
    expect(jobLinks.map(link => link.jobId)).toEqual([...new Set(jobUpdates.map(job => job.id)), running.id]);
    const script = trace.toolCalls.find(call => call.toolName === "codemode")!;
    expect(jobLinks[1]?.call.parentToolCallId).toBe(script.id.slice(script.runId.length + 1));
    const history = events.find(event => event.type === "session.messages");
    if (history?.type !== "session.messages") throw new Error("missing history");
    // No synthetic start messages; only the notice required to replay the wake-up turn.
    const notices = history.messages.filter(message => message.communication);
    expect(notices).toHaveLength(1);
    expect(notices[0]?.communication?.backgroundJobId).toBe(jobLinks[0]?.jobId);
    expect(history.messages.filter(message => message.role === "user" && !message.communication).map(message => message.content)).toEqual(["BUILD_IN_BACKGROUND", "LIVE_CASE", "LEAVE_IT_RUNNING"]);
    await send({ type: "secret.set", requestId: "restore-key", key: "model.apiKey:background-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
    await run("after-restart", "AFTER_RESTART");
    await wait(() => completed().length >= 1);
    expect(JSON.stringify(completed()[0])).toContain("RESTORED_OK");
    expect(errors).toEqual([]);
  } finally {
    child.kill(); await child.exited; await output; await stderr;
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 90000);
