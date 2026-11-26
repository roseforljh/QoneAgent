import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ConfigFile, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent, ScheduleInfo } from "@qone/protocol";

// Real runtime process + local provider: a turn killed mid-tool resumes after restart, and a scheduled task runs.
test("a restart keeps a turn's finished tool steps and continues it; scheduled tasks append to their own conversation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-automation-e2e-"));
  const errors: string[] = [];
  let hung = false;
  const chunk = (delta: object, reason: string | null) => `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "model", choices: [{ index: 0, delta, finish_reason: reason }] })}\n\n`;
  const sse = (delta: object, reason = "stop") => new Response(chunk(delta, null) + chunk({}, reason) + "data: [DONE]\n\n", { headers: { "Content-Type": "text/event-stream" } });
  const tool = (name: string, args: object) => sse({ role: "assistant", tool_calls: [{ index: 0, id: crypto.randomUUID(), type: "function", function: { name, arguments: JSON.stringify(args) } }] }, "tool_calls");
  const say = (content: string) => sse({ role: "assistant", content });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    const body = await request.json() as { messages: { role: string; content: unknown }[] };
    const transcript = JSON.stringify(body.messages);
    const last = JSON.stringify(body.messages.findLast((message) => message.role === "user")?.content);
    if (last.includes("应用重启")) {
      // The resumed turn sees the tool result that finished before the crash.
      if (!transcript.includes("TOOL_DONE")) errors.push(`recovered history lost the tool result: ${transcript.slice(-800)}`);
      return say("RECOVERED_DONE");
    }
    if (last.includes("SCHEDULED_TASK")) return say("SCHEDULE_DONE");
    if (last.includes("RECOVER_ME") && !transcript.includes("TOOL_DONE")) return tool("powershell", { command: "'TOOL_' + 'DONE'" });
    if (last.includes("RECOVER_ME")) {
      hung = true; // The process is killed while this reply is streaming.
      return new Response(new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode(chunk({ role: "assistant", content: "half" }, null))); } }), { headers: { "Content-Type": "text/event-stream" } });
    }
    errors.push(`unexpected request: ${transcript.slice(-400)}`);
    return new Response("unexpected", { status: 500 });
  } });
  const database = path.join(directory, "agent.db");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("E2E", directory);
  const session = new SessionRepo(db).create("Main", workspace.id);
  new ModelConfigRepo(new ConfigFile(path.join(directory, "settings.json"))).upsert({ provider: "automation-e2e", model: "model", enabled: true, config: {
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
  const send = async (command: RuntimeCommand) => { child.stdin.write(JSON.stringify(command) + "\n"); await child.stdin.flush(); };
  const collect = (process: typeof child) => (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of process.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n"); buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) {
        const value = JSON.parse(line);
        for (const event of (Array.isArray(value) ? value : [value]) as RuntimeEvent[]) {
          events.push(event);
          // Stands in for the desktop's encrypted secret store.
          if (event.type === "mcp.credentials.request") void send({ type: "mcp.credentials.restored", requestId: event.requestId, ok: true, values: Object.fromEntries(event.keys.map((key) => [key, "local-test-only"])) });
        }
      }
    }
  })();
  let output = collect(child), stderr = new Response(child.stderr).text();
  const completed = () => events.flatMap((event) => event.type === "agent.event" && event.event.type === "agent.completed" ? [event.event] : []);
  const wait = async (predicate: () => boolean, label: string) => {
    const deadline = Date.now() + 40000;
    while (!predicate()) {
      if (errors.length || Date.now() > deadline) throw new Error(`${label}: ${JSON.stringify({ errors, events: events.slice(-12).map((event) => event.type === "agent.event" ? event.event.type : event.type) })}`);
      await Bun.sleep(10);
    }
  };
  const history = async (sessionId: string, requestId: string) => {
    await send({ type: "session.messages", requestId, sessionId });
    await wait(() => events.some((event) => event.type === "session.messages" && event.requestId === requestId), "history");
    const found = events.find((event) => event.type === "session.messages" && event.requestId === requestId);
    if (found?.type !== "session.messages") throw new Error("missing history");
    return found.messages;
  };
  try {
    await send({ type: "secret.set", requestId: "key", key: "model.apiKey:automation-e2e", value: "local-test-only" });
    await wait(() => events.some((event) => event.type === "secret.saved"), "key");
    await send({ type: "agent.run", requestId: "start", sessionId: session.id, message: "RECOVER_ME", model: "automation-e2e/model", permissionMode: "full" });
    await wait(() => hung, "tool step");
    // Kill like the desktop does (process tree), with the turn mid-reply.
    child.kill(); await child.exited; await output; await stderr;

    events = []; child = spawn(); output = collect(child); stderr = new Response(child.stderr).text();
    await wait(() => completed().some((event) => JSON.stringify(event).includes("RECOVERED_DONE")), "resume");
    const recovered = await history(session.id, "after-restart");
    const toolStep = recovered.find((message) => message.role === "assistant" && message.parts?.some((part) => part.type === "tool-call"));
    expect(toolStep?.parts?.find((part) => part.type === "tool-call")).toMatchObject({ toolName: "powershell", isError: false });
    expect(JSON.stringify(toolStep?.parts)).toContain("TOOL_DONE");
    expect(recovered.filter((message) => message.communication).map((message) => message.content)).toEqual(["回复过程中 Qone 重启了，已保留完成的步骤并继续执行。"]);

    await send({ type: "schedule.save", requestId: "save", schedule: {
      title: "Daily report", prompt: "SCHEDULED_TASK", workspaceId: workspace.id, rule: { kind: "daily", time: "09:00" },
      enabled: true, model: "automation-e2e/model", permissionMode: "full",
    } });
    await wait(() => events.some((event) => event.type === "schedule.list" && event.requestId === "save"), "save");
    const saved = (events.find((event) => event.type === "schedule.list" && event.requestId === "save") as { schedules: ScheduleInfo[] }).schedules[0]!;
    expect(saved.nextRunAt).toBeGreaterThan(Date.now());
    for (const requestId of ["run-1", "run-2"]) {
      const before = completed().length;
      await send({ type: "schedule.run", requestId, id: saved.id });
      await wait(() => completed().length > before && events.some((event) => event.type === "schedule.list" && event.schedules[0]?.lastStatus === "completed" && event.schedules[0].lastRunAt! > 0), requestId);
    }
    const latest = events.findLast((event) => event.type === "schedule.list") as { schedules: ScheduleInfo[]; runs: { scheduleId: string; sessionId: string; status: string }[] };
    const taskSession = latest.schedules[0]!.sessionId!;
    expect(latest.runs.map((run) => [run.scheduleId, run.sessionId, run.status])).toEqual([[saved.id, taskSession, "completed"], [saved.id, taskSession, "completed"]]);
    expect(taskSession).not.toBe(session.id);
    expect(events.some((event) => event.type === "session.list" && event.sessions.some((item) => item.id === taskSession && item.title === "Daily report"))).toBe(true);
    // Each run appends a turn; the identical prompt never replaces the previous one.
    const task = await history(taskSession, "task-history");
    expect(task.filter((message) => message.communication).map((message) => message.communication?.fromTitle)).toEqual(["定时任务 · Daily report", "定时任务 · Daily report"]);
    expect(task.filter((message) => message.role === "assistant").map((message) => message.content)).toEqual(["SCHEDULE_DONE", "SCHEDULE_DONE"]);
    expect(errors).toEqual([]);
  } finally {
    child.kill(); await child.exited; await output; await stderr;
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 120000);
