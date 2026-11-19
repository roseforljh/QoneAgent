import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { closeDb, EventRepo, GoalRepo, openDb, SessionRepo, SettingsRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { buildRuntime, runtimeBundle } from "../../desktop/scripts/build-runtime";
import builderConfig from "../../desktop/electron-builder.json";

const desktopRoot = path.resolve(path.dirname(runtimeBundle), "..");
const requireFromBuilder = createRequire(Bun.resolveSync("electron-builder", desktopRoot));
const { copyFiles, getFileMatchers } = requireFromBuilder("app-builder-lib/out/fileMatcher");

function electronExecutable() {
  const electron = Bun.spawnSync([process.execPath, "--print", 'require("electron")'], {
    cwd: desktopRoot,
  });
  if (electron.exitCode !== 0) throw new Error(electron.stderr.toString());
  return electron.stdout.toString().trim();
}

test("Electron sidecar survives cancellation during the read tool's file stat", () => {
  const child = Bun.spawnSync([electronExecutable(), "--input-type=module", "--eval", `
    import assert from "node:assert/strict";
    import { open } from "node:fs/promises";
    import { createReadTool } from ${JSON.stringify(import.meta.resolve("@earendil-works/pi-coding-agent"))};
    const file = ${JSON.stringify(import.meta.path)};
    const handle = await open(file);
    const prototype = Object.getPrototypeOf(handle);
    await handle.close();
    const read = createReadTool(process.cwd());
    const args = { path: file, offset: 1, limit: 1 };
    const result = await read.execute("normal", args);
    assert.match(result.content[0].text, /import/);
    const controller = new AbortController();
    const stat = prototype.stat;
    prototype.stat = async function (...options) {
      const result = await stat.apply(this, options);
      controller.abort();
      return result;
    };
    await assert.rejects(read.execute("cancelled", args, controller.signal), /Operation aborted/);
    assert(controller.signal.aborted);
  `], { env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10_000 });
  if (child.exitCode !== 0) throw new Error(child.stderr.toString());
});

async function waitFor(check: () => boolean, label: string) {
  const deadline = Date.now() + 5000;
  while (!check()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await Bun.sleep(25);
  }
}

test("the standalone Electron sidecar survives goal and journal write failures and runs Codemode with image reads", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "qone-codemode-bundle-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    const { messages } = await request.json() as { messages: { role: string }[] };
    const finished = messages.some(message => message.role === "tool");
    const delta = finished ? { content: "done" } : { tool_calls: [{ index: 0, id: "sandbox-call", type: "function",
      function: { name: "codemode", arguments: JSON.stringify({ code: `const image = await tools.read({ path: ${JSON.stringify(path.join(root, "pixel.png"))} });
        text(image?.type === "image" ? "qone-" + "codemode-ok" : String(image));` }) } }] };
    const chunk = { id: "local", object: "chat.completion.chunk", created: 1, model: "test", choices: [
      { index: 0, delta, finish_reason: finished ? "stop" : "tool_calls" },
    ] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    // The read tool resizes images with Photon WASM; a missing WASM file drops every image.
    await writeFile(path.join(root, "pixel.png"), Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==", "base64"));
    const staging = path.join(root, "staging");
    const resources = path.join(root, "resources");
    await buildRuntime(path.join(staging, "binaries", path.basename(runtimeBundle)));
    // Exercise the same extraResources copy as the installer, not just the staging tree.
    await copyFiles(getFileMatchers(builderConfig, "extraResources", resources, {
      defaultSrc: staging, globalOutDir: resources, customBuildOptions: builderConfig.win,
      macroExpander: (value: string) => value,
    }));
    const bundle = path.join(resources, "binaries", path.basename(runtimeBundle));
    // Pi resizes images in a worker beside the bundle; a missing worker silently blocks the runtime instead.
    const resize = Bun.spawnSync([electronExecutable(), "--input-type=module", "--eval", `
      import { readFileSync } from "node:fs";
      import { Worker } from "node:worker_threads";
      const worker = new Worker(${JSON.stringify(path.join(path.dirname(bundle), "image-resize-worker.js"))}, { execArgv: [] });
      worker.once("error", (error) => { console.error(error); process.exit(1); });
      worker.once("message", (message) => { console.log(JSON.stringify(message)); void worker.terminate(); });
      worker.postMessage({ inputBytes: new Uint8Array(readFileSync(${JSON.stringify(path.join(root, "pixel.png"))})), mimeType: "image/png" });
    `], { cwd: root, env: { ...process.env, NODE_PATH: undefined, NODE_OPTIONS: undefined, ELECTRON_RUN_AS_NODE: "1" }, timeout: 10_000 });
    if (resize.exitCode !== 0) throw new Error(resize.stderr.toString());
    expect(JSON.parse(resize.stdout.toString()).result).toMatchObject({ mimeType: "image/png", width: 1, height: 1 });
    const data = path.join(root, "profile");
    await mkdir(data);
    await writeFile(path.join(data, "settings.json"), JSON.stringify({ models: { "local/test": {
      provider: "local", model: "test", apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`,
      contextWindow: 128000, maxTokens: 1024, input: ["text"], output: ["text"], thinking: "none",
    } } }));
    const database = path.join(data, "test.db");
    const db = openDb(database);
    let sessionId: string, failedSessionId: string;
    try {
      const workspace = new WorkspaceRepo(db).upsert("Test", root);
      const sessions = new SessionRepo(db), goals = new GoalRepo(db);
      sessionId = sessions.create("Codemode", workspace.id).id;
      failedSessionId = sessions.create("Goal", workspace.id).id;
      const goal = goals.create(failedSessionId, "Test goal start failure");
      goals.update(goal.id, { status: "paused" });
      db.$client.exec(`CREATE TRIGGER fail_goal_run BEFORE INSERT ON runs
        WHEN NEW.session_id = '${failedSessionId}' BEGIN SELECT RAISE(ABORT, 'test goal start failure'); END;
        CREATE TRIGGER fail_event_insert BEFORE INSERT ON events
          BEGIN SELECT RAISE(ABORT, 'test event insert failure'); END;
        CREATE TRIGGER fail_event_sequence BEFORE INSERT ON settings
          WHEN NEW.key = 'event.sequence' BEGIN SELECT RAISE(ABORT, 'test event sequence failure'); END;`);
    } finally { closeDb(db); }
    const child = Bun.spawn([electronExecutable(), bundle], {
      cwd: path.dirname(bundle), stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 20_000,
      env: { ...process.env, NODE_PATH: undefined, NODE_OPTIONS: undefined, ELECTRON_RUN_AS_NODE: "1",
        HOME: root, USERPROFILE: root, QONE_DATA_DIR: data, QONE_DB: database, QONE_LOG_DIR: path.join(data, "logs") },
    });
    const send = (command: RuntimeCommand) => child.stdin.write(`${JSON.stringify(command)}\n`);
    try {
      send({ type: "ping", requestId: "ready" });
      let goalFailures = 0, codemodeCompleted = false;
      const skill = "qone-test-recreated-skill";
      for await (const line of createInterface({ input: Readable.fromWeb(child.stdout) })) {
        const decoded = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
        for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
          if (event.type === "pong" && event.requestId === "journal-recovered") return;
          if (event.type === "pong" && event.requestId === "ready") {
            const skills = path.join(data, "skills", "installed");
            await rm(skills, { recursive: true });
            await mkdir(path.join(skills, skill), { recursive: true });
            await writeFile(path.join(skills, skill, "SKILL.md"), `---\nname: ${skill}\ndescription: Test reloading skills after replacing their directory\n---\n`);
          }
          if (event.type === "skills.list" && event.skills.some(item => item.name === skill)) {
            send({ type: "goal.resume", requestId: "failed-goal", sessionId: failedSessionId });
          }
          if (event.type === "error") {
            if (!event.message.includes("test goal start failure")) throw new Error(event.message);
            if (++goalFailures === 1) {
              expect(event.requestId).toBe("failed-goal");
              send({ type: "goal.get", requestId: "auto-goal", sessionId: failedSessionId });
            } else {
              expect(goalFailures).toBe(2);
              send({ type: "secret.set", requestId: "key", key: "model.apiKey:local", value: "local-test-only" });
            }
          }
          if (event.type === "secret.saved") send({ type: "agent.run", requestId: "run", sessionId,
            message: "Run Codemode", model: "local/test", permissionMode: "full" });
          if (event.type !== "agent.event") continue;
          const { type, payload } = event.event;
          if (type === "agent.failed") throw new Error(JSON.stringify(payload));
          if (type === "agent.completed") {
            expect(codemodeCompleted).toBe(true);
            const live = openDb(database);
            try {
              const journal = new EventRepo(live), settings = new SettingsRepo(live);
              const runtimeLog = Bun.file(path.join(data, "logs", "runtime.log"));
              let log = "";
              const deadline = Date.now() + 3000;
              while (!log.includes('"msg":"event journal write deferred"')) {
                if (child.exitCode !== null || Date.now() >= deadline) throw new Error("Sidecar did not survive the event write failure");
                await Bun.sleep(25);
                log = await runtimeLog.text();
              }
              expect(log).toContain("test event insert failure");
              expect(journal.list()).toHaveLength(0);
              live.$client.exec("DROP TRIGGER fail_event_insert");
              const completed = event.event;
              await waitFor(() => journal.list().some(row => row.eventId === completed.eventId), "retry to save the original completion event");
              expect(settings.get("event.sequence")).toBeUndefined();
              live.$client.exec("DROP TRIGGER fail_event_sequence");
              await waitFor(() => (settings.get<number>("event.sequence") ?? 0) > completed.sequence, "retry to save the sequence watermark");
              expect(journal.list().filter(row => row.eventId === completed.eventId)).toHaveLength(1);
            } finally { closeDb(live); }
            send({ type: "ping", requestId: "journal-recovered" });
          }
          if ((type !== "tool.completed" && type !== "tool.failed") || payload?.toolName !== "codemode") continue;
          if (type === "tool.failed") throw new Error(JSON.stringify(payload.result));
          expect(JSON.stringify(payload.result)).toContain("qone-codemode-ok");
          codemodeCompleted = true;
        }
      }
      throw new Error(`Sidecar exited or timed out before completion (goal failures: ${goalFailures}, Codemode returned: ${codemodeCompleted})`);
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
