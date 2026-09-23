// Smoke test: speaks NDJSON to the runtime process directly.
// Usage: bun test/smoke.ts
import { mkdirSync, mkdtempSync } from "node:fs";
import { Database } from "bun:sqlite";
import path from "node:path";

const testDir = path.join(import.meta.dir, "..", ".test-data");
mkdirSync(testDir, { recursive: true });
const sandbox = mkdtempSync(path.join(testDir, "smoke-"));
const testDb = path.join(sandbox, "agent.db");
const runtimeExecutable = process.env.QONE_SMOKE_RUNTIME;
const proc = Bun.spawn(runtimeExecutable ? [runtimeExecutable] : ["bun", "run", "src/index.ts"], {
  cwd: import.meta.dir + "/..",
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env, QONE_DB: testDb, QONE_LOG_DIR: path.join(sandbox, "logs"), QONE_PLUGINS_DIR: path.join(sandbox, "plugins") },
});

const send = (o: object) => proc.stdin.write(JSON.stringify(o) + "\n");

// Give the child a moment to boot before writing (bun run has startup cost).
await new Promise((r) => setTimeout(r, 800));

send({ type: "ping", requestId: "1" });
send({ type: "session.create", requestId: "2", title: "smoke" });
send({ type: "session.list", requestId: "3" });
send({ type: "workspace.list", requestId: "4" });
send({ type: "workspace.upsert", requestId: "5", name: "smoke", path: sandbox });
send({ type: "skills.list", requestId: "6", cwd: sandbox });
send({ type: "model.upsert", requestId: "7", config: { provider: "demo", model: "demo", config: { apiKey: "plaintext" } } });
send({ type: "model.resolve-metadata", requestId: "8", provider: "demo", apiType: "codex", baseUrl: "https://example.test", models: [{ id: "smoke-model", metadata: { contextWindow: 64_000, maxTokens: 4_096, reasoning: true, reasoningOptions: [{ type: "effort", values: ["low", "high"] }] } }] });
send({ type: "future.command", requestId: "9" });
await proc.stdin.flush();

const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let buf = "";
let pongs = 0;
let sessions = 0;
let catalogs = 0;
let secretRejections = 0;
let metadataResolved = 0;
let unsupportedRejected = 0;

const deadline = Date.now() + 8000;
let pendingRead = reader.read();
while (Date.now() < deadline && (pongs < 1 || sessions < 2 || catalogs < 2 || secretRejections < 1 || metadataResolved < 1 || unsupportedRejected < 1)) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const { value, done } = await Promise.race([
    pendingRead,
    new Promise<{ value: undefined; done: false }>((resolve) => {
      timer = setTimeout(() => resolve({ value: undefined, done: false }), Math.min(500, deadline - Date.now()));
    }),
  ]);
  if (timer) clearTimeout(timer);
  if (done) break;
  if (!value) continue;
  pendingRead = reader.read();
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "pong" && msg.capabilities?.includes("model.resolve-metadata") && msg.capabilities?.includes("model.metadata-sources")) pongs++;
    if (msg.type === "session.created" || msg.type === "session.list") sessions++;
    if (msg.type === "workspace.list" || msg.type === "skills.list") catalogs++;
    if (msg.type === "error" && msg.requestId === "7") secretRejections++;
    if (msg.type === "model.metadata-resolved" && msg.requestId === "8" && msg.models?.[0]?.metadata?.contextWindow === 64_000 && msg.models?.[0]?.thinkingLevels?.includes("low") && msg.models?.[0]?.sources?.contextWindow === "provider") metadataResolved++;
    if (msg.type === "error" && msg.requestId === "9" && msg.message?.includes("unsupported command")) unsupportedRejected++;
  }
}

proc.kill();
await proc.exited;
if (pongs < 1) throw new Error("no pong");
if (sessions < 2) throw new Error("session commands failed");
if (catalogs < 2) throw new Error("catalog commands failed");
if (secretRejections < 1) throw new Error("plaintext model secret was accepted");
if (metadataResolved < 1) throw new Error("model metadata query failed");
if (unsupportedRejected < 1) throw new Error("unsupported command was silently dropped");
// Verify the child actually used the isolated database, not the desktop profile.
const db = new Database(testDb, { readonly: true });
try {
  const sessions = db.query("SELECT title FROM sessions").all() as { title: string }[];
  const workspaces = db.query("SELECT path FROM workspaces").all() as { path: string }[];
  if (sessions.length !== 1 || sessions[0]?.title !== "smoke") throw new Error("smoke sessions were not isolated");
  if (workspaces.length !== 1 || workspaces[0]?.path !== sandbox) throw new Error("smoke workspace was not isolated");
} finally {
  db.close();
}
console.log(`smoke ok: pongs=${pongs} sessionEvents=${sessions} catalogs=${catalogs} secretRejections=${secretRejections} metadataResolved=${metadataResolved}`);
