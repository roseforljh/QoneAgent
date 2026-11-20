import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeDb, ConfigFile, ModelConfigRepo, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { buildRuntime } from "../../desktop/scripts/build-runtime.js";

const overview = "## User profile\nNone\n## User preferences\nNone\n## General tips\nVerify command syntax.\n## What's in memory\nNone";

test("the selected memory provider is used after a turn and after restart without falling back to chat", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-memory-recovery-"));
  const database = path.join(directory, "qone.db");
  const bundle = path.join(directory, "binaries", "qone-runtime.mjs");
  const electronPath = Bun.spawnSync([process.execPath, "--print", 'require("electron")'], {
    cwd: path.resolve(import.meta.dir, "../../desktop"),
  });
  if (electronPath.exitCode !== 0) throw new Error(electronPath.stderr.toString());
  const electron = electronPath.stdout.toString().trim();
  await buildRuntime(bundle);
  const privateOutput = "PRIVATE_TOOL_OUTPUT_CANARY";
  const enduring = "For future tasks, verify a focused test before reporting completion.";
  const suggestion = "Run a focused check before reporting completion.";
  const requests: { kind: "summary" | "overview"; text: string; route: string }[] = [];
  const chatRoutes: string[] = [];
  const interruptedReply = Promise.withResolvers<void>();
  const stream = (delta: object, finish = "stop") => new Response(
    `data: ${JSON.stringify({ id: crypto.randomUUID(), object: "chat.completion.chunk", created: 1, model: "fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\ndata: [DONE]\n\n`,
    { headers: { "Content-Type": "text/event-stream" } },
  );
  const text = (content: string) => stream({ role: "assistant", content });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    const route = new URL(request.url).pathname;
    if (!route.endsWith("/chat/completions")) return Response.json({ data: [] });
    const { messages } = await request.json() as { messages: { role: string; content: unknown }[] };
    const system = JSON.stringify(messages[0]?.content);
    const prompt = JSON.stringify(messages);
    if (system.includes("Consolidate the supplied conversation summaries")) {
      requests.push({ kind: "overview", text: prompt, route });
      return text(JSON.stringify({ overview, preferences: [{ content: suggestion, scope: "workspace", basis: "explicit",
        evidence: [{ id: session.id, quote: enduring }] }] }));
    }
    if (system.includes("part of Qone's memory system")) {
      requests.push({ kind: "summary", text: prompt, route });
      return text(JSON.stringify({ title: "Fixture", summary: "A recorded conversation outcome." }));
    }
    if (system.includes("Generate a concise conversation title")) return text('{"title":"Fixture"}');
    chatRoutes.push(route);
    if (JSON.stringify(messages.findLast(item => item.role === "user")?.content).includes("force-close-case")) {
      if (messages.some(item => item.role === "tool")) {
        await interruptedReply.promise;
        return text("Late response");
      }
      return stream({ role: "assistant", tool_calls: [{ index: 0, id: "fixture-tool-id", type: "function", function: {
        name: "powershell", arguments: JSON.stringify({ command: `Write-Output '${privateOutput}'; exit 7` }),
      } }] }, "tool_calls");
    }
    return text("Turn completed normally.");
  } });
  const db = openDb(database);
  const workspace = new WorkspaceRepo(db).upsert("Fixture", directory);
  const session = new SessionRepo(db).create("Recovery test", workspace.id);
  closeDb(db);
  const config = new ConfigFile(path.join(directory, "settings.json"));
  config.write("preferences", { "memory.enabled": true });
  const configs = new ModelConfigRepo(config);
  for (const provider of ["memory-provider", "chat-provider"]) configs.upsert({ provider, model: "fixture", enabled: true, config: {
    apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/${provider}/v1`, thinking: "none", autoMetadata: false,
    contextWindow: 32_000, maxTokens: 8192, input: ["text"], output: ["text"],
    modelMetadata: { id: "fixture", contextWindow: 32_000, maxTokens: 8192, reasoning: false, input: ["text"], output: ["text"] },
  } });
  const memoryModel = "memory-provider/fixture";
  const spawn = () => {
    const proc = Bun.spawn([electron, bundle], {
      cwd: directory, stdin: "pipe", stdout: "pipe", stderr: "pipe",
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", NODE_PATH: undefined, NODE_OPTIONS: undefined,
        HOME: directory, USERPROFILE: directory, APPDATA: directory, QONE_DATA_DIR: directory, QONE_DB: database,
        QONE_MCP_SERVERS: "", QONE_LOG_DIR: path.join(directory, "logs") },
    });
    const events: RuntimeEvent[] = [];
    const collecting = (async () => {
      let partial = "";
      for await (const chunk of proc.stdout.pipeThrough(new TextDecoderStream())) {
        const lines = (partial + chunk).split("\n");
        partial = lines.pop()!;
        for (const line of lines.filter(Boolean)) {
          const data = JSON.parse(line);
          events.push(...(Array.isArray(data) ? data : [data]));
        }
      }
    })();
    const stderr = new Response(proc.stderr).text();
    const send = (command: RuntimeCommand) => proc.stdin.write(JSON.stringify(command) + "\n");
    return {
      send,
      async wait(predicate: (event: RuntimeEvent) => boolean) {
        const deadline = Date.now() + 9_000;
        while (!events.some(predicate)) {
          if (proc.exitCode !== null) throw new Error(await stderr);
          if (Date.now() > deadline) throw new Error(`Missing event: ${JSON.stringify(events.slice(-6))}`);
          await Bun.sleep(10);
        }
      },
      async stop() { proc.kill("SIGKILL"); await proc.exited; await collecting; await stderr; },
    };
  };
  const rows = () => {
    const databaseHandle = new DatabaseSync(database, { readOnly: true });
    try { return databaseHandle.prepare("SELECT * FROM execution_incidents ORDER BY id LIKE 'interrupted-run:%' DESC, at").all(); }
    finally { databaseHandle.close(); }
  };
  let child = spawn();
  const authenticate = async (provider: string) => {
    child.send({ type: "ping", requestId: `ready-${provider}` });
    await child.wait(e => e.type === "pong" && e.requestId === `ready-${provider}`);
    child.send({ type: "secret.set", requestId: provider, key: `model.apiKey:${provider}`, value: "fixture-local-key" });
    await child.wait(e => e.type === "secret.saved" && e.requestId === provider);
  };
  const run = (message: string) => child.send({ type: "agent.run", requestId: crypto.randomUUID(), sessionId: session.id,
    message, model: "chat-provider/fixture", permissionMode: "full" });
  const updated = (e: RuntimeEvent) => e.type === "memory.state" && Boolean(e.state.overview);
  try {
    await authenticate("chat-provider");
    child.send({ type: "memory.model.set", requestId: "unknown-model", modelId: "missing/fixture" });
    await child.wait(e => e.type === "error" && e.requestId === "unknown-model");
    child.send({ type: "memory.model.set", requestId: "select-model", modelId: memoryModel });
    await child.wait(e => e.type === "memory.state" && e.requestId === "select-model" && e.state.modelId === memoryModel);
    expect(new ConfigFile(config.file).read("preferences")).toMatchObject({ "memory.model": memoryModel });
    run(`normal-turn-case. ${enduring}`);
    await child.wait(e => e.type === "agent.event" && e.event.type === "agent.completed");
    await authenticate("memory-provider");
    await child.wait(updated);
    await child.wait(e => e.type === "memory.state" && e.state.automaticPreferences?.some(item => item.content === suggestion
      && item.preference.workspaceId === workspace.id && item.sources[0]?.quote === enduring) === true);
    expect(requests.map(r => r.kind)).toEqual(["summary", "overview"]);
    expect(requests.every(r => r.route.startsWith("/memory-provider/"))).toBe(true);
    run("force-close-case");
    await child.wait(e => e.type === "agent.event" && e.event.type === "tool.failed");
    expect(rows()).toMatchObject([{ tool: "powershell", outcome: "failed", reason: "nonzero-exit" }]);
    expect(JSON.stringify(rows())).not.toContain(privateOutput);
    await child.stop();
    interruptedReply.resolve();

    child = spawn();
    await authenticate("chat-provider");
    await authenticate("memory-provider");
    await child.wait(e => e.type === "memory.state" && e.state.modelId === memoryModel && Boolean(e.state.overview));
    expect(rows()).toMatchObject([{ tool: null, outcome: "interrupted", reason: "outcome-unknown" }, { tool: "powershell", outcome: "failed" }]);
    expect(requests.map(r => r.kind)).toEqual(["summary", "overview", "summary", "overview"]);
    expect(requests[3]!.text).not.toContain("outcome-unknown");
    expect(requests[3]!.text).not.toContain("nonzero-exit");
    expect(JSON.stringify(requests)).not.toContain(privateOutput);
    expect(requests.every(r => r.route.startsWith("/memory-provider/"))).toBe(true);
    expect(chatRoutes.every(route => route.startsWith("/chat-provider/"))).toBe(true);
    await child.stop();

    child = spawn();
    await authenticate("memory-provider");
    child.send({ type: "memory.get", requestId: "unchanged" });
    await child.wait(e => e.type === "memory.state" && e.requestId === "unchanged" && e.state.modelId === memoryModel && Boolean(e.state.overview));
    child.send({ type: "memory.model.set", requestId: "auto", modelId: null });
    await child.wait(e => e.type === "memory.state" && e.requestId === "auto" && e.state.modelId === undefined);
    expect(new ConfigFile(config.file).read<Record<string, unknown>>("preferences")?.["memory.model"]).toBeUndefined();
    await Bun.sleep(250);
    expect(requests).toHaveLength(4);
    expect(rows()).toHaveLength(2);
  } finally {
    interruptedReply.resolve();
    await child.stop();
    server.stop(true);
    await rm(directory, { recursive: true, force: true, maxRetries: 15, retryDelay: 100 });
  }
}, 45_000);
