// Smoke test: speaks NDJSON to the runtime process directly.
// Usage: bun test/smoke.ts
import { mkdirSync, mkdtempSync } from "node:fs";
import { Database } from "bun:sqlite";
import path from "node:path";
import { closeDb, openDb, SessionRepo } from "@qone/database";

const testDir = path.join(import.meta.dir, "..", ".test-data");
mkdirSync(testDir, { recursive: true });
const sandbox = mkdtempSync(path.join(testDir, "smoke-"));
const testDb = path.join(sandbox, "agent.db");
// Legacy records stay on disk, but must not appear as usable project chats.
const seedDb = openDb(testDb);
new SessionRepo(seedDb).create("legacy-unassigned");
new SessionRepo(seedDb).create("legacy-orphan", "deleted-workspace");
closeDb(seedDb);
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
send({ type: "session.create", requestId: "missing-workspace", title: "invalid" });
send({ type: "session.create", requestId: "unknown-workspace", title: "invalid", workspaceId: "unknown" });
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
let sessionCreateSent = false;
const rejectedSessions = new Set<string>();
let visibleSessionTitles: string[] | undefined;

const deadline = Date.now() + 8000;
let pendingRead = reader.read();
while (Date.now() < deadline && (pongs < 1 || sessions < 2 || catalogs < 2 || secretRejections < 1 || metadataResolved < 1 || unsupportedRejected < 1 || rejectedSessions.size < 2)) {
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
    if (msg.type === "workspace.updated" && !sessionCreateSent) {
      sessionCreateSent = true;
      send({ type: "session.create", requestId: "2", title: "smoke", workspaceId: msg.workspace.id });
      send({ type: "session.list", requestId: "3" });
      await proc.stdin.flush();
    }
    if (msg.type === "pong" && msg.capabilities?.includes("model.resolve-metadata") && msg.capabilities?.includes("model.metadata-sources")) pongs++;
    if (msg.type === "session.created" || msg.type === "session.list") sessions++;
    if (msg.type === "session.list") visibleSessionTitles = msg.sessions.map((session: { title: string }) => session.title);
    if (msg.type === "error" && ["missing-workspace", "unknown-workspace"].includes(msg.requestId)) rejectedSessions.add(msg.requestId);
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
if (rejectedSessions.size !== 2) throw new Error("sessions without a known workspace were accepted");
if (visibleSessionTitles?.length !== 1 || visibleSessionTitles[0] !== "smoke") throw new Error("session list included orphaned chats or lost the valid chat");
// Verify the child actually used the isolated database, not the desktop profile.
const db = new Database(testDb, { readonly: true });
try {
  const sessions = db.query("SELECT title, workspace_id AS workspaceId FROM sessions").all() as { title: string; workspaceId: string | null }[];
  const workspaces = db.query("SELECT id, path FROM workspaces").all() as { id: string; path: string }[];
  if (sessions.length !== 3 || !sessions.some((session) => session.title === "legacy-unassigned") || !sessions.some((session) => session.title === "legacy-orphan")) throw new Error("legacy sessions were deleted or invalid sessions were inserted");
  if (sessions.find((session) => session.title === "smoke")?.workspaceId !== workspaces[0]?.id) throw new Error("new session was not bound to the workspace");
  if (workspaces.length !== 1 || workspaces[0]?.path !== sandbox) throw new Error("smoke workspace was not isolated");
} finally {
  db.close();
}
console.log(`smoke ok: pongs=${pongs} sessionEvents=${sessions} catalogs=${catalogs} secretRejections=${secretRejections} metadataResolved=${metadataResolved}`);
