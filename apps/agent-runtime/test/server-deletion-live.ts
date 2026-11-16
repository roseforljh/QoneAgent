// Explicitly destructive opt-in: deletes exactly the configured server named by ID.
// QONE_E2E_DELETE_SERVER_ID=<id> bun apps/agent-runtime/test/server-deletion-live.ts
// Uses the already-running desktop IPC, not a second production runtime/browser.
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { Database } from "bun:sqlite";
import { qoneSettingsPath, qoneDatabasePath, qoneAuthDir } from "@qone/shared";
import type { ServerInfo } from "@qone/protocol";
import { connect, credentialsFor, exec } from "../src/servers/ssh";

const id = process.env.QONE_E2E_DELETE_SERVER_ID;
assert(id, "Set QONE_E2E_DELETE_SERVER_ID explicitly; no automatic destructive target");
const settingsText = () => readFileSync(qoneSettingsPath(), "utf8");
const inventory = () => (JSON.parse(settingsText()).preferences?.["servers.list"] ?? []) as ServerInfo[];
const before = inventory();
const server = before.find(item => item.id === id);
assert(server && server.auth.kind === "key" && server.auth.dedicated, "Expected an existing dedicated-key server");
const keyPath = server.auth.keyPath;
const credentials = credentialsFor(server);
const runtime = new Database(qoneDatabasePath(), { readonly: true });
assert.equal((runtime.query("SELECT count(*) AS n FROM runs WHERE status IN ('created','running','paused','waiting_approval')").get() as { n: number }).n, 0, "Do not restart an active runtime");
const verifier = await connect(server, credentials, server.hostKey);
const authorization = async () => {
  const result = await exec(verifier, "cat ~/.ssh/authorized_keys", { timeoutMs: 10_000 });
  assert.equal(result.exit_code, 0, "Cannot inspect authorization file");
  return result.stdout.split(/\r?\n/).filter(Boolean);
};
const lines = await authorization();
const marker = `qone:${id}`;
const dedicated = lines.filter(line => line.endsWith(` ${marker}`));
assert.equal(dedicated.length, 1, "Expected exactly one dedicated authorization before deletion");
const tabs = await (await fetch("http://127.0.0.1:9222/json/list")).json() as { type: string; webSocketDebuggerUrl: string }[];
const page = tabs.find(item => item.type === "page");
assert(page, "Existing desktop debug endpoint is unavailable");
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise<void>((resolve, reject) => { socket.onopen = () => resolve(); socket.onerror = reject; });
let sequence = 0;
async function evaluate(expression: string): Promise<any> {
  const request = ++sequence;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener("message", receive); reject(new Error("Desktop IPC timeout")); }, 45_000);
    function receive(event: MessageEvent) {
      const message = JSON.parse(String(event.data));
      if (message.id !== request) return;
      clearTimeout(timer); socket.removeEventListener("message", receive);
      if (message.error || message.result?.exceptionDetails) reject(new Error(JSON.stringify(message.error ?? message.result.exceptionDetails)));
      else resolve(message.result.result.value);
    }
    socket.addEventListener("message", receive);
    socket.send(JSON.stringify({ id: request, method: "Runtime.evaluate", params: { expression, awaitPromise: true, returnByValue: true } }));
  });
}
const command = async (value: object, restart = false) => evaluate(`(async()=>{
 const bridge=window.electronBridge; const requestId=crypto.randomUUID();
 let off; let timer;
 const result=new Promise((resolve,reject)=>{
 timer=setTimeout(()=>reject(new Error("runtime response timeout")),35000);
 bridge.listen("runtime-event",({payload})=>{let items=typeof payload==="string"?JSON.parse(payload):payload;
 for(const event of Array.isArray(items)?items:[items]) if(event.requestId===requestId){
 if(event.type==="error") reject(new Error(event.message));
 else if(event.type==="servers.state"||event.type==="pong") resolve({type:event.type,servers:event.servers?.map(s=>({id:s.id,name:s.name})),tunnels:event.tunnels});
 }}).then(stop=>off=stop);
 });
 try{${restart ? 'await bridge.invoke("runtime_restart");' : ""}
 await bridge.invoke("runtime_send",{cmd:JSON.stringify({...${JSON.stringify(value)},requestId})});
 return await result;}finally{clearTimeout(timer);off?.();}
})()`);
try {
  await command({ type: "ping" }, true);
  const initial = await command({ type: "servers.list" });
  assert(initial.servers.some((item: { id: string }) => item.id === id));
  const deleted = await command({ type: "servers.delete", id });
  assert(!deleted.servers.some((item: { id: string }) => item.id === id));
  assert(!deleted.tunnels.some((item: { serverId: string }) => item.serverId === id));
  assert(!existsSync(keyPath), "Dedicated private key remains on disk");
  assert(!readdirSync(`${qoneAuthDir()}/ssh`).some(name => name.includes(id)), "Dedicated key sidecar remains");
  assert(!settingsText().includes(id), "Configuration still references the deleted server");
  assert.equal((runtime.query("SELECT count(*) AS n FROM settings WHERE instr(value,?)>0").get(id) as { n: number }).n, 0, "Runtime settings still reference the deleted server");
  const afterLines = await authorization();
  assert(!afterLines.some(line => line.includes(marker)), "Remote public key remains");
  assert.deepEqual(afterLines, lines.filter(line => !dedicated.includes(line)), "Unrelated remote authorizations were changed");
  const after = inventory();
  assert.deepEqual(after, before.filter(item => item.id !== id), "Another server's configuration was modified");
  let rejected = false;
  try { const unexpected = await connect(server, credentials, server.hostKey); unexpected.end(); }
  catch (error) { rejected = /authentication|auth methods|permission denied/i.test(String(error)); }
  assert(rejected, "The deleted dedicated private key can still authenticate");
  const cache = await evaluate(`(async()=>{
 const id=${JSON.stringify(id)};
 const cached=Object.keys(localStorage).filter(k=>localStorage.getItem(k)?.includes(id));
 const urls=performance.getEntriesByType("resource").map(e=>e.name);
 const latest=urls.filter(url=>/\\/src\\/store\\.ts(?:\\?|$)/.test(url)).at(-1);
 const state=latest?(await import(latest)).useStore.getState():null;
 return {cached,selected:state?JSON.stringify([state.draftRunOptions,state.runOptionsBySession]).includes(id):null};
})()`);
  assert.deepEqual(cache.cached, [], "Deleted server remains in desktop storage");
  assert.equal(cache.selected, false, "Deleted server remains selected in memory");
  await command({ type: "ping" }, true);
  const restarted = await command({ type: "servers.list" });
  assert(!restarted.servers.some((item: { id: string }) => item.id === id), "Server revived after runtime restart");
  console.log(JSON.stringify({ name: server.name, deletion: "passed", remoteKeysBefore: dedicated.length, remoteKeysAfter: 0,
    localPrivateKeysAfter: 0, databaseReferencesAfter: 0, desktopReferencesAfter: 0, remainingServers: after.map(item => item.name), revokedKeyLogin: "rejected", survivesRestart: true }));
} finally {
  verifier.end(); socket.close(); runtime.close();
}
