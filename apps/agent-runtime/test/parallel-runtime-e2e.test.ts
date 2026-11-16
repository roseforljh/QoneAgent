import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeDb, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";

// Real runtime process + HTTP/SSE provider, no credentials, paid requests or browser.
test("parallel runtime sessions preserve streamed answers and their persisted history across restart", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "qone-parallel-e2e-"));
  const requests: { label: string; messages: { role: string; content: unknown }[] }[] = [];
  let releaseStreams!: () => void;
  const streamsMayFinish = new Promise<void>(resolve => { releaseStreams = resolve; });
  let releaseDeletion!: () => void;
  const deletionMayFinish = new Promise<void>(resolve => { releaseDeletion = resolve; });
  const server = Bun.serve({ port: 0, hostname: "127.0.0.1", async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    const body = await request.json() as { messages: { role: string; content: unknown }[] };
    const prompt = JSON.stringify(body.messages.findLast(message => message.role === "user")?.content);
    const label = /PARALLEL_SESSION_(\d+)/.exec(prompt)?.[0];
    if (!label) return new Response("unknown prompt", { status: 400 });
    requests.push({ label, messages: body.messages });
    const encoder = new TextEncoder();
    return new Response(new ReadableStream({ async start(controller) {
      const write = (delta: object, finish_reason: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ id: label, object: "chat.completion.chunk", created: 1, model: "parallel-model", choices: [{ index: 0, delta, finish_reason }] })}\n\n`));
      write({ role: "assistant" });
      await streamsMayFinish;
      if (prompt.includes("DELETE_WHILE_STREAMING")) await deletionMayFinish;
      for (let index = 0; index < 16; index++) {
        write({ content: `${label}:${index}\n` });
        await Bun.sleep(1);
      }
      write({}, "stop");
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    } }), { headers: { "Content-Type": "text/event-stream" } });
  } });
  const database = path.join(directory, "agent.db");
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("E2E workspace", directory);
  const sessions = Array.from({ length: 8 }, (_, index) => new SessionRepo(db).create(`parallel-${index}`, workspace.id));
  new ModelConfigRepo(db).upsert({ provider: "parallel-e2e", model: "parallel-model", enabled: true, config: {
    apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`, thinking: "none",
    contextWindow: 128000, maxTokens: 8192, input: ["text"], output: ["text"],
  } });
  closeDb(db);
  const spawn = () => Bun.spawn([Bun.which("bun")!, "run", "src/index.ts"], {
    cwd: path.resolve(import.meta.dir, ".."), stdin: "pipe", stdout: "pipe", stderr: "pipe",
    env: { ...Bun.env, QONE_DATA_DIR: directory, QONE_DB: database, APPDATA: directory,
      QONE_LOG_DIR: path.join(directory, "logs"), QONE_PLUGINS_DIR: path.join(directory, "plugins") },
  });
  let process = spawn();
  let events: RuntimeEvent[] = [];
  const collect = (child: typeof process) => (async () => {
    let buffer = "";
    const decoder = new TextDecoder();
    for await (const bytes of child.stdout) {
      buffer += decoder.decode(bytes, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop()!;
      for (const line of lines) if (line.trim()) {
        const batch = JSON.parse(line);
        events.push(...(Array.isArray(batch) ? batch : [batch]));
      }
    }
  })();
  let output = collect(process);
  let stderr = new Response(process.stderr).text();
  const send = async (command: RuntimeCommand) => { process.stdin.write(JSON.stringify(command) + "\n"); await process.stdin.flush(); };
  const wait = async (predicate: () => boolean) => {
    const deadline = Date.now() + 20000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error(`E2E timeout: ${JSON.stringify(events.slice(-8))}`);
      await Bun.sleep(5);
    }
  };
  try {
    await send({ type: "secret.set", requestId: "key", key: "model.apiKey:parallel-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
    await Promise.all(sessions.map((session, index) => send({ type: "agent.run", requestId: `run-${index}`, sessionId: session.id,
      message: `PARALLEL_SESSION_${index}`, model: "parallel-e2e/parallel-model", permissionMode: "full" })));
    await wait(() => requests.length === sessions.length);
    await send({ type: "ping", requestId: "while-streaming" });
    await wait(() => events.some(event => event.type === "pong" && event.requestId === "while-streaming"));
    expect(events.filter(event => event.type === "agent.event" && event.event.type === "agent.completed")).toHaveLength(0);
    releaseStreams();
    await wait(() => events.filter(event => event.type === "agent.event" && event.event.type === "agent.completed").length === sessions.length);
    expect(events.filter(event => event.type === "agent.event" && event.event.type === "agent.failed")).toEqual([]);
    expect(new Set(requests.map(request => request.label)).size).toBe(sessions.length);
    for (const [index, session] of sessions.entries()) {
      const final = events.find(event => event.type === "agent.event" && event.event.sessionId === session.id && event.event.type === "agent.completed");
      expect(JSON.stringify(final)).toContain(`PARALLEL_SESSION_${index}:15`);
      expect(events.filter(event => event.type === "agent.event" && event.event.sessionId === session.id).map(event => event.type === "agent.event" ? event.event.type : "")).toContain("message.delta");
    }
    await send({ type: "events.replay", requestId: "replay-markers" });
    await wait(() => events.some(event => event.type === "events.replay"));
    const replay = events.find(event => event.type === "events.replay");
    if (replay?.type !== "events.replay") throw new Error("missing replay");
    expect(replay.events.filter(event => event.type === "agent.completed").map(event => event.payload)).toEqual(sessions.map(() => ({})));
    // A second run rebuilds the released Pi session from the canonical transcript.
    await Promise.all(sessions.map((session, index) => send({ type: "agent.run", requestId: `again-${index}`, sessionId: session.id,
      message: `PARALLEL_SESSION_${index} continue`, model: "parallel-e2e/parallel-model", permissionMode: "full" })));
    await wait(() => events.filter(event => event.type === "agent.event" && event.event.type === "agent.completed").length === sessions.length * 2);
    expect(events.filter(event => event.type === "agent.event" && event.event.type === "agent.failed")).toEqual([]);
    for (let index = 0; index < sessions.length; index++) {
      const turns = requests.filter(request => request.label === `PARALLEL_SESSION_${index}`);
      expect(turns).toHaveLength(2);
      expect(turns[1]!.messages.slice(0, turns[0]!.messages.length)).toEqual(turns[0]!.messages);
      expect(turns[1]!.messages.filter(message => message.role === "assistant")).toHaveLength(1);
      expect(JSON.stringify(turns[1]!.messages.filter(message => message.role === "assistant"))).toContain(`PARALLEL_SESSION_${index}:15`);
    }
    process.kill(); await process.exited; await output; await stderr;
    events = [];
    process = spawn(); output = collect(process); stderr = new Response(process.stderr).text();
    await Promise.all(sessions.map(session => send({ type: "session.messages", requestId: session.id, sessionId: session.id })));
    await wait(() => events.filter(event => event.type === "session.messages").length === sessions.length);
    for (const [index, session] of sessions.entries()) {
      const event = events.find(event => event.type === "session.messages" && event.sessionId === session.id);
      if (event?.type !== "session.messages") throw new Error("missing history");
      expect(event.messages.filter(message => message.role === "user")).toHaveLength(2);
      expect(event.messages.filter(message => message.role === "assistant")).toHaveLength(2);
      const saved = event.messages.find(message => message.role === "assistant")!;
      expect(saved.content).toBe(Array.from({ length: 16 }, (_, chunk) => `PARALLEL_SESSION_${index}:${chunk}\n`).join("").trim());
    }
    await send({ type: "secret.set", requestId: "delete-key", key: "model.apiKey:parallel-e2e", value: "local-test-only" });
    await wait(() => events.some(event => event.type === "secret.saved"));
    await send({ type: "agent.run", requestId: "delete-run", sessionId: sessions[0]!.id,
      message: "PARALLEL_SESSION_0 DELETE_WHILE_STREAMING", model: "parallel-e2e/parallel-model", permissionMode: "full" });
    await wait(() => requests.length === sessions.length * 2 + 1);
    await send({ type: "session.delete", requestId: "delete-live-session", sessionId: sessions[0]!.id });
    await wait(() => events.some(event => event.type === "pong" && event.requestId === "delete-live-session"));
    releaseDeletion();
    expect(events.filter(event => event.type === "error")).toEqual([]);
    process.kill(); await process.exited; await output; await stderr;
    const restored = openDb(database);
    try { expect(new SessionRepo(restored).get(sessions[0]!.id)).toBeUndefined(); }
    finally { closeDb(restored); }
  } finally {
    releaseDeletion();
    releaseStreams();
    process.kill(); await process.exited; await output; await stderr;
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
  }
}, 60000);
