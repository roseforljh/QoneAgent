// Smoke test: speaks NDJSON to the runtime process directly.
// Usage: bun test/smoke.ts
import { mkdirSync } from "node:fs";
import path from "node:path";

const testDir = path.join(import.meta.dir, "..", ".test-data");
mkdirSync(testDir, { recursive: true });
const proc = Bun.spawn(["bun", "run", "src/index.ts"], {
  cwd: import.meta.dir + "/..",
  stdin: "pipe",
  stdout: "pipe",
  stderr: "inherit",
  env: { ...process.env, QONE_DB: path.join(testDir, `smoke-${crypto.randomUUID()}.db`), QONE_LOG_DIR: path.join(testDir, "logs") },
});

const send = (o: object) => proc.stdin.write(JSON.stringify(o) + "\n");

// Give the child a moment to boot before writing (bun run has startup cost).
await new Promise((r) => setTimeout(r, 800));

send({ type: "ping", requestId: "1" });
send({ type: "session.create", requestId: "2", title: "smoke" });
send({ type: "session.list", requestId: "3" });
send({ type: "workspace.list", requestId: "4" });
send({ type: "workspace.upsert", requestId: "5", name: "smoke", path: process.cwd() });
send({ type: "skills.list", requestId: "6", cwd: process.cwd() });
send({ type: "model.upsert", requestId: "7", config: { provider: "demo", model: "demo", config: { apiKey: "plaintext" } } });
await proc.stdin.flush();

const reader = proc.stdout.getReader();
const decoder = new TextDecoder();
let buf = "";
let pongs = 0;
let sessions = 0;
let catalogs = 0;
let secretRejections = 0;

const deadline = Date.now() + 8000;
while (Date.now() < deadline && (pongs < 1 || sessions < 2 || catalogs < 2 || secretRejections < 1)) {
  const { value, done } = await Promise.race([
    reader.read(),
    new Promise<{ value: undefined; done: false }>((r) =>
      setTimeout(() => r({ value: undefined, done: false }), 500)
    ),
  ]);
  if (done) break;
  if (!value) continue;
  buf += decoder.decode(value, { stream: true });
  const lines = buf.split("\n");
  buf = lines.pop() ?? "";
  for (const line of lines) {
    if (!line.trim()) continue;
    const msg = JSON.parse(line);
    if (msg.type === "pong") pongs++;
    if (msg.type === "session.created" || msg.type === "session.list") sessions++;
    if (msg.type === "workspace.list" || msg.type === "skills.list") catalogs++;
    if (msg.type === "error" && msg.requestId === "7") secretRejections++;
  }
}

proc.kill();
if (pongs < 1) throw new Error("no pong");
if (sessions < 2) throw new Error("session commands failed");
if (catalogs < 2) throw new Error("catalog commands failed");
if (secretRejections < 1) throw new Error("plaintext model secret was accepted");
console.log(`smoke ok: pongs=${pongs} sessionEvents=${sessions} catalogs=${catalogs} secretRejections=${secretRejections}`);
