import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { Readable } from "node:stream";
import { closeDb, openDb, SessionRepo, WorkspaceRepo } from "@qone/database";
import type { RuntimeCommand, RuntimeEvent } from "@qone/protocol";
import { buildRuntime, runtimeBundle } from "../../desktop/scripts/build-runtime";
import builderConfig from "../../desktop/electron-builder.json";

const desktopRoot = path.resolve(path.dirname(runtimeBundle), "..");
const requireFromBuilder = createRequire(Bun.resolveSync("electron-builder", desktopRoot));
const { copyFiles, getFileMatchers } = requireFromBuilder("app-builder-lib/out/fileMatcher");

test("the standalone Electron sidecar runs Codemode without the source dependency tree", async () => {
  const electron = Bun.spawnSync([process.execPath, "--print", 'require("electron")'], {
    cwd: desktopRoot,
  });
  if (electron.exitCode !== 0) throw new Error(electron.stderr.toString());
  const root = await mkdtemp(path.join(os.tmpdir(), "qone-codemode-bundle-"));
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
    if (!new URL(request.url).pathname.endsWith("/chat/completions")) return Response.json({ data: [] });
    const { messages } = await request.json() as { messages: { role: string }[] };
    const finished = messages.some(message => message.role === "tool");
    const delta = finished ? { content: "done" } : { tool_calls: [{ index: 0, id: "sandbox-call", type: "function",
      function: { name: "codemode", arguments: JSON.stringify({ code: 'text("qone-" + "codemode-ok");' }) } }] };
    const chunk = { id: "local", object: "chat.completion.chunk", created: 1, model: "test", choices: [
      { index: 0, delta, finish_reason: finished ? "stop" : "tool_calls" },
    ] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "Content-Type": "text/event-stream" } });
  } });
  try {
    const staging = path.join(root, "staging");
    const resources = path.join(root, "resources");
    await buildRuntime(path.join(staging, "binaries", path.basename(runtimeBundle)));
    // Exercise the same extraResources copy as the installer, not just the staging tree.
    await copyFiles(getFileMatchers(builderConfig, "extraResources", resources, {
      defaultSrc: staging, globalOutDir: resources, customBuildOptions: builderConfig.win,
      macroExpander: (value: string) => value,
    }));
    const bundle = path.join(resources, "binaries", path.basename(runtimeBundle));
    const data = path.join(root, "profile");
    await mkdir(data);
    await writeFile(path.join(data, "settings.json"), JSON.stringify({ models: { "local/test": {
      provider: "local", model: "test", apiType: "openai-compatible", baseUrl: `http://127.0.0.1:${server.port}/v1`,
      contextWindow: 128000, maxTokens: 1024, input: ["text"], output: ["text"], thinking: "none",
    } } }));
    const database = path.join(data, "test.db");
    const db = openDb(database);
    let sessionId: string;
    try {
      const workspace = new WorkspaceRepo(db).upsert("Test", root);
      sessionId = new SessionRepo(db).create("Codemode", workspace.id).id;
    } finally { closeDb(db); }
    const child = Bun.spawn([electron.stdout.toString().trim(), bundle], {
      cwd: path.dirname(bundle), stdin: "pipe", stdout: "pipe", stderr: "inherit", timeout: 20_000,
      env: { ...process.env, NODE_PATH: undefined, NODE_OPTIONS: undefined, ELECTRON_RUN_AS_NODE: "1",
        HOME: root, USERPROFILE: root, QONE_DATA_DIR: data, QONE_DB: database, QONE_LOG_DIR: path.join(data, "logs") },
    });
    const send = (command: RuntimeCommand) => child.stdin.write(`${JSON.stringify(command)}\n`);
    try {
      send({ type: "secret.set", requestId: "key", key: "model.apiKey:local", value: "local-test-only" });
      for await (const line of createInterface({ input: Readable.fromWeb(child.stdout) })) {
        const decoded = JSON.parse(line) as RuntimeEvent | RuntimeEvent[];
        for (const event of Array.isArray(decoded) ? decoded : [decoded]) {
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "secret.saved") send({ type: "agent.run", requestId: "run", sessionId,
            message: "Run Codemode", model: "local/test", permissionMode: "full" });
          if (event.type !== "agent.event") continue;
          const { type, payload } = event.event;
          if (type === "agent.failed") throw new Error(JSON.stringify(payload));
          if ((type !== "tool.completed" && type !== "tool.failed") || payload?.toolName !== "codemode") continue;
          if (type === "tool.failed") throw new Error(JSON.stringify(payload.result));
          expect(JSON.stringify(payload.result)).toContain("qone-codemode-ok");
          return;
        }
      }
      throw new Error("Sidecar exited or timed out before Codemode returned");
    } finally {
      child.kill();
      await child.exited;
    }
  } finally {
    server.stop(true);
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  }
}, 30_000);
