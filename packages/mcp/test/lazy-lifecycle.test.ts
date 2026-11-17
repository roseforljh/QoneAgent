import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { McpManager, type McpServerConfig } from "../src/index";
import { catalogKey, configFingerprint, readCatalog } from "../src/tool-catalog";

const fixture = path.join(import.meta.dir, "fixtures/stdio-server.ts");
const wait = async (condition: () => boolean) => {
  const end = Date.now() + 5000;
  while (!condition()) { if (Date.now() > end) throw new Error("condition timed out"); await Bun.sleep(10); }
};

test("list_changed updates cached tools and a removed tool handle never sends another call", async () => {
  const manager = new McpManager();
  try {
    const tools = await manager.connect({ id: "changing", name: "Changing", command: process.execPath, args: ["run", fixture], env: { QONE_MCP_TEST_MUTATE: "1" } });
    const echo = tools.find(tool => tool.qoneToolName?.endsWith(":echo"))!;
    await echo.execute("remove", { text: "remove echo" }, undefined, undefined, {} as never);
    await wait(() => manager.toolCount("changing") === 2);
    await expect(echo.execute("removed", { text: "must not run" }, undefined, undefined, {} as never)).rejects.toThrow("changed");
    expect(manager.tools()).toHaveLength(2);
  } finally { await manager.disconnectAll(); }
});

test("cancelling one waiter does not cancel another caller's shared handshake", async () => {
  let release!: () => void;
  const ready = new Promise<void>(resolve => { release = resolve; });
  let handshakes = 0;
  const config = { id: "shared", name: "Shared", command: process.execPath, args: ["run", fixture] };
  const cache = new Map<string, unknown>([[catalogKey(config.id), { fingerprint: configFingerprint(config), tools: [{ name: "echo", inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] } }] }]]);
  const manager = new McpManager(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => { handshakes++; await ready; }, undefined, { catalog: { get: key => cache.get(key), set: (key, value) => { cache.set(key, value); }, delete: key => { cache.delete(key); } } });
  try {
    manager.register(config);
    const controller = new AbortController();
    const pending = manager.callTool(config.id, "echo", { text: "survives" });
    const echo = manager.tools()[0]!;
    const cancelled = echo.execute("cancel", { text: "cancelled" }, controller.signal, undefined, {} as never).catch(error => error);
    await wait(() => handshakes === 1);
    controller.abort(new Error("cancelled only this call"));
    expect((await cancelled).message).toBe("cancelled only this call");
    release(); await pending;
    expect(handshakes).toBe(1);
    expect(manager.isConnected(config.id)).toBe(true);
  } finally { release(); await manager.disconnectAll(); }
});

test("cached catalogs spawn only on use, share wakeups, recycle safely and never revive removed tools", async () => {
  const root = mkdtempSync(path.join(tmpdir(), "qone-mcp-lazy-"));
  const log = path.join(root, "calls.ndjson");
  const cache = new Map<string, unknown>();
  let permitted = true, credentials = 0;
  const options = { catalog: { get: (k: string) => cache.get(k), set: (k: string, v: unknown) => { cache.set(k, structuredClone(v)); }, delete: (k: string) => { cache.delete(k); } }, canConnect: () => permitted };
  const create = () => new McpManager(undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, async () => { credentials++; }, undefined, options);
  let manager = create();
  const config: McpServerConfig = { id: "lazy", name: "Lazy", command: process.execPath, args: ["run", fixture], env: { QONE_MCP_TEST_LOG: log } };
  const events = () => { try { return readFileSync(log, "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } };
  const starts = () => events().filter(e => e.event === "start").length;
  try {
    await manager.discover(config);
    expect(starts()).toBe(1);
    expect(manager.isConnected(config.id)).toBe(false);
    expect(manager.isAvailable(config.id)).toBe(true);
    expect(manager.tools()).toHaveLength(3);
    await manager.disconnectAll();
    manager = create();
    expect(manager.register(config)).toBe(true);
    expect(starts()).toBe(1);
    expect(credentials).toBe(1);
    const echo = manager.tools().find(tool => tool.qoneToolName?.endsWith(":echo"))!;
    const call = (text: string, signal?: AbortSignal) => echo.execute(text, { text }, signal, undefined, {} as never);
    const [result] = await Promise.all([call("one"), manager.callTool(config.id, "echo", { text: "two" })]);
    expect(starts()).toBe(2);
    expect(result.structuredContent).toEqual({ text: "one", length: 3 });
    await Bun.sleep(40);
    expect(manager.isConnected(config.id)).toBe(true); // Used servers stay alive until app exit.
    const controller = new AbortController();
    const slow = manager.tools().find(tool => tool.qoneToolName?.endsWith(":slow"))!;
    const slowCall = slow.execute("slow", {}, controller.signal, undefined, {} as never).catch(error => error);
    await wait(() => events().some(e => e.event === "slow-start"));
    await Bun.sleep(60);
    expect(manager.isConnected(config.id)).toBe(true);
    controller.abort();
    await slowCall;
    await call("after-cancel");
    expect(starts()).toBe(2);
    const pid = events().filter(e => e.event === "start").at(-1)!.pid;
    process.kill(pid);
    await wait(() => !manager.isConnected(config.id));
    await call("after-crash");
    expect(starts()).toBe(3);
    expect(manager.isConnected(config.id)).toBe(true);
    permitted = false;
    await expect(call("denied")).rejects.toThrow("not authorized");
    permitted = true;
    await manager.disconnect(config.id);
    await expect(call("deleted")).rejects.toThrow();
    expect(cache.has(catalogKey(config.id))).toBe(false);
    expect(manager.register(config)).toBe(false);
    expect(readCatalog({ fingerprint: configFingerprint(config), tools: [{ name: "bad" }] }, configFingerprint(config))).toBeUndefined();
    expect(configFingerprint(config)).not.toBe(configFingerprint({ ...config, args: ["changed"] }));
  } finally { await manager.disconnectAll(); rmSync(root, { recursive: true, force: true }); }
}, 15_000);
