// Real model + real SSH, through the desktop's NDJSON runtime boundary.
// bun apps/agent-runtime/test/execution-context-live.ts
// Optional: QONE_E2E_MODEL=provider/model. Reuses existing credentials; never logs them.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { hostname } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";
import { ConfigFile, ModelConfigRepo, PreferencesRepo } from "@qone/database";
import type { ServerInfo } from "@qone/protocol";
import { qoneDataDir } from "@qone/shared";
import { connect, credentialsFor, exec } from "../src/servers/ssh";

const root = path.resolve(import.meta.dir, "../../..");
const profile = qoneDataDir();
const source = new ConfigFile(path.join(profile, "settings.json"));
const configured = new ModelConfigRepo(source).list();
const history = new Database(path.join(profile, "runtime/qone.db"), { readonly: true });
const recent = history.query("SELECT model FROM messages WHERE model IS NOT NULL ORDER BY created_at DESC LIMIT 1").get() as { model: string } | null;
history.close();
const model = configured.find(item => item.id === (process.env.QONE_E2E_MODEL ?? recent?.model)) ?? configured[0];
assert(model, "No configured model");
const servers: ServerInfo[] = new PreferencesRepo(source).get<ServerInfo[]>("servers.list") ?? [];
const server = servers.find(item => item.status === "ready");
assert(server, "No ready real server configured");
assert(server.hostKey, "The real server needs an already trusted host key");
const testRoot = path.join(import.meta.dir, "../.test-data");
await mkdir(testRoot, { recursive: true });
const sandbox = await mkdtemp(path.join(testRoot, "execution-live-"));
const workspace = path.join(sandbox, "workspace");
await mkdir(workspace);
const config = new ConfigFile(path.join(sandbox, "settings.json"));
new ModelConfigRepo(config).upsert(model);
new PreferencesRepo(config).set("servers.list", servers);
for (const name of ["Qone.md", "system-prompts"]) {
  if (existsSync(path.join(profile, name))) await cp(path.join(profile, name), path.join(sandbox, name), { recursive: true });
}

// Electron safeStorage needs the main process, not a renderer/browser window.
// The decrypted value goes straight through the child's pipe, never a file/log.
const decryptFile = path.join(sandbox, "read-credential.cjs");
await writeFile(decryptFile, `const {app,safeStorage}=require("electron");
app.whenReady().then(()=>{try {
 const entry=JSON.parse(require("fs").readFileSync(process.env.QONE_E2E_SECRETS,"utf8"))[process.env.QONE_E2E_SECRET_KEY];
 if(!entry?.isSafeStorage) throw new Error("Expected existing safeStorage credential");
 const value=safeStorage.decryptString(Buffer.from(entry.data,"base64"));
 process.stdout.write(JSON.stringify({value})); app.quit();
} catch { process.stderr.write("Credential decryption failed"); app.exit(1); }});`);
const electron = createRequire(path.join(root, "apps/desktop/package.json"))("electron") as string;
const credentialProcess = Bun.spawn([electron, decryptFile], {
  env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined, QONE_E2E_SECRETS: path.join(profile, "auth/secrets.enc.json"), QONE_E2E_SECRET_KEY: `model.apiKey:${model.provider}` },
  stdout: "pipe", stderr: "pipe",
});
const credentialOutput = await new Response(credentialProcess.stdout).text();
assert.equal(await credentialProcess.exited, 0, "Could not decrypt the existing model credential");
const credential = JSON.parse(credentialOutput).value as string;
assert(credential, "Empty model credential");
const connection = await connect(server, credentialsFor(server), server.hostKey);
let baseline: string[];
try {
  const result = await exec(connection, "hostname; uname -s; pwd", { timeoutMs: 10_000 });
  assert.equal(result.exit_code, 0);
  baseline = result.stdout.trim().split(/\r?\n/);
  assert.equal(baseline.length, 3);
} finally { connection.end(); }

const stderrFile = Bun.file(path.join(sandbox, "runtime.log"));
const proc = Bun.spawn([process.execPath, "run", path.join(root, "apps/agent-runtime/src/index.ts")], {
  cwd: path.join(root, "apps/agent-runtime"), stdin: "pipe", stdout: "pipe", stderr: stderrFile,
  env: { ...process.env, QONE_DATA_DIR: sandbox, QONE_DB: path.join(sandbox, "runtime/qone.db") },
});
type Event = { type: string; [key: string]: any };
const events: Event[] = [];
const waiters = new Set<() => void>();
const read = (async () => {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of proc.stdout) {
    buffer += decoder.decode(chunk, { stream: true });
    let newline: number;
    while ((newline = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
      if (!line.trim()) continue;
      const value = JSON.parse(line);
      events.push(...(Array.isArray(value) ? value : [value]));
      for (const notify of waiters) notify();
    }
  }
})();
let request = 0;
async function send(command: Event) {
  const requestId = String(++request);
  await proc.stdin.write(JSON.stringify({ ...command, requestId, locale: "zh-CN" }) + "\n");
  await proc.stdin.flush();
  return requestId;
}
async function wait(predicate: (event: Event) => boolean, after = 0, timeout = 150_000): Promise<Event> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { waiters.delete(check); reject(new Error(`Runtime timeout; events=${events.length}`)); }, timeout);
    function check() {
      const error = events.slice(after).find(event => event.type === "error");
      const event = events.slice(after).find(predicate);
      if (!event && !error) return;
      clearTimeout(timer); waiters.delete(check);
      if (error) reject(new Error(error.message)); else resolve(event!);
    }
    waiters.add(check); check();
  });
}
async function session() {
  const after = events.length;
  await send({ type: "session.create", workspaceId, title: "execution-live" });
  return (await wait(event => event.type === "session.created", after)).session.id as string;
}
const reports: object[] = [];
async function turn(name: string, id: string, message: string, serverIds: string[]) {
  const after = events.length;
  await send({ type: "agent.run", sessionId: id, message, model: model!.id, permissionMode: "full", serverIds });
  const final = await wait(event => event.type === "agent.event" && event.event.sessionId === id && ["agent.completed", "agent.failed", "agent.cancelled"].includes(event.event.type), after);
  const runEvents = events.slice(after).filter(event => event.type === "agent.event" && event.event.runId === final.event.runId).map(event => event.event);
  const tools = runEvents.filter(event => event.type === "tool.started").map(event => event.payload);
  const results = runEvents.filter(event => ["tool.completed", "tool.failed"].includes(event.type)).map(event => event.payload);
  const text = final.event.payload.message?.content ?? runEvents.filter(event => event.type === "message.delta").map(event => event.payload.delta ?? "").join("");
  const report = { name, status: final.event.type, text, tools, results };
  reports.push(report);
  await writeFile(path.join(sandbox, "evidence.json"), JSON.stringify({ model: model!.id, reports }, null, 2));
  console.log(JSON.stringify({ name, status: final.event.type, tools: tools.map(tool => tool.toolName), text }));
  assert.equal(final.event.type, "agent.completed", JSON.stringify(final.event.payload));
  assert(text.trim(), "Empty model response");
  return { text, tools, results };
}
function remote(result: Awaited<ReturnType<typeof turn>>, target = server!) {
  assert(!result.tools.some(tool => tool.toolName === "powershell"), "Remote task ran locally");
  const completed = result.results.filter(tool => tool.toolName === "server_exec" && !tool.isError);
  assert(completed.length, "No successful real SSH execution");
  for (const tool of completed) assert.equal(tool.result.details.serverOperation.serverId, target.id);
  return JSON.stringify(completed);
}
function local(result: Awaited<ReturnType<typeof turn>>) {
  assert(!result.tools.some(tool => tool.toolName.startsWith("server_")), "Local task ran remotely");
  const completed = result.results.filter(tool => tool.toolName === "powershell" && !tool.isError);
  assert(completed.length, "No successful local command execution");
  const output = JSON.stringify(completed);
  assert(output.toLowerCase().includes(hostname().toLowerCase()), "Local identity mismatch");
}
let workspaceId: string;
let passed = false;
try {
  const secretRequest = await send({ type: "secret.set", key: `model.apiKey:${model.provider}`, value: credential });
  await wait(event => event.type === "secret.saved" && event.requestId === secretRequest);
  await send({ type: "workspace.upsert", name: "execution-live", path: workspace });
  workspaceId = (await wait(event => event.type === "workspace.updated")).workspace.id;
  if (servers.length > 1) {
    const newest = [...servers].sort((a, b) => b.createdAt - a.createdAt)[0]!;
    const scope = servers.map(item => item.id);
    const multiId = await session();
    const ambiguous = await turn("ambiguous-multiple-servers", multiId, "查一下服务器的主机名、操作系统和当前目录，只查询，不修改文件或配置。", scope);
    assert.equal(ambiguous.tools.length, 0, "Multiple-server ambiguity triggered operations");
    assert.match(ambiguous.text, /[?？]/);
    for (const item of servers) assert(ambiguous.text.includes(item.name), "Clarification omitted an available server");
    const client = await connect(newest, credentialsFor(newest), newest.hostKey);
    let expected: string[];
    try {
      const result = await exec(client, "hostname; uname -s; pwd", { timeoutMs: 10_000 });
      assert.equal(result.exit_code, 0);
      expected = result.stdout.trim().split(/\r?\n/);
    } finally { client.end(); }
    const clarified = remote(await turn("clarified-new-server", multiId, `在服务器“${newest.name}”上执行刚才的查询。`, scope), newest);
    for (const value of expected) assert(clarified.includes(value), "New server identity mismatch");
    remote(await turn("confirmed-new-server-follow-up", multiId, "再查一下这台机器的运行时长，只查询。", scope), newest);
    remote(await turn("switch-back-to-original-server", multiId, `改在服务器“${server.name}”查询主机名和当前目录。`, scope));
    local(await turn("explicit-local-with-two-servers", await session(), "在本机电脑上运行只读命令查询主机名和当前目录。", scope));
    console.log(JSON.stringify({ passed: reports.length, model: model.id, realServers: servers.length }));
    passed = true;
  } else {
  const scope = [server.id];
  const ambiguousId = await session();
  const ambiguous = await turn("ambiguous-local-or-server", ambiguousId, "查一下主机名、操作系统和当前目录，只查询，不修改文件或配置。", scope);
  assert.equal(ambiguous.tools.length, 0, "Ambiguous request performed operations before clarification");
  assert.match(ambiguous.text, /[?？]/);
  assert(ambiguous.text.includes(server.name) && /本机|本地|电脑/.test(ambiguous.text));
  const clarified = remote(await turn("clarified-remote", ambiguousId, `在服务器“${server.name}”上执行刚才的查询。`, scope));
  for (const value of baseline) assert(clarified.includes(value), `Remote identity missing ${value}`);
  remote(await turn("confirmed-remote-follow-up", ambiguousId, "再查一下这台机器的运行时长，只查询。", scope));
  local(await turn("explicit-local-with-server-enabled", await session(), "在本机电脑上运行只读命令，查询主机名、操作系统和当前工作目录，不修改文件或配置。", scope));
  const disabled = await turn("historical-remote-not-enabled", ambiguousId, "再查一下刚才那台服务器的主机名。", []);
  assert.equal(disabled.tools.length, 0, "Disabled remote target was substituted with local execution");
  assert.match(disabled.text, /启用|开启|勾选|选中|添加|连接|授权/);
  local(await turn("local-only-scope", await session(), "查一下本机主机名和当前工作目录，只查询。", []));
  console.log(JSON.stringify({ passed: reports.length, model: model.id, realServers: servers.length, multiServer: servers.length < 2 ? "not available" : "not tested" }));
  passed = true;
  }
} finally {
  proc.stdin.end();
  proc.kill();
  await proc.exited;
  await read;
  if (passed) await rm(sandbox, { recursive: true, force: true });
  else console.error(`Evidence retained: ${sandbox}`);
}
