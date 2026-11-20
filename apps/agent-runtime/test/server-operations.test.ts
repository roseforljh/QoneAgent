import { expect, test } from "bun:test";
import { EventEmitter, once } from "node:events";
import { createConnection } from "node:net";
import type { Client, ClientChannel } from "ssh2";
import { exec, sftp, abortable } from "../src/servers/ssh";
import { createServerTools, ServerSessions } from "../src/servers/server-tools";
import { serverOperationInfo, serverOperationCancelled, type ServerInfo } from "@qone/protocol";
import { closeDb, openDb, RunRepo, SessionRepo, ToolCallRepo } from "@qone/database";

class Channel extends EventEmitter {
  stderr = new EventEmitter();
  signals: string[] = [];
  closed = false;
  signal(value: string) { this.signals.push(value); }
  close() { this.closed = true; this.emit("close", null, "KILL"); }
}
const target: ServerInfo = { id: "a", name: "Alpha", host: "a.example", port: 22, username: "root", status: "ready", auth: { kind: "agent" }, createdAt: 0 };
const clientFor = (channel: Channel) => ({ exec: (_: string, callback: Function) => callback(null, channel) }) as unknown as Client;

function tools(client: Client, sessions = {} as any) {
  return createServerTools({ servers: () => [target], pool: { get: async () => client } as never, sessions, workspacePath: ".", onActivity() {} });
}

test("SSH streams bounded stdout/stderr snapshots before completion and keeps UTF-8 across chunks", async () => {
  const channel = new Channel(), updates: any[] = [];
  const pending = exec(clientFor(channel), "diagnostic", { onUpdate: update => updates.push(update) });
  const bytes = Buffer.from("服务器");
  channel.emit("data", bytes.subarray(0, 2)); channel.emit("data", bytes.subarray(2));
  channel.stderr.emit("data", Buffer.from("warning"));
  for (let index = 0; index < 200; index++) channel.emit("data", Buffer.from("x".repeat(8192)));
  await Bun.sleep(115);
  expect(updates).toHaveLength(1);
  expect(updates[0].stdout).toStartWith("服务器");
  expect(updates[0].stderr).toBe("warning");
  expect(updates[0].stdout.length).toBeLessThan(66_000);
  expect(updates[0].truncated).toBe(true);
  channel.emit("close", 0);
  expect((await pending).exit_code).toBe(0);
});

test("SSH guards all commands behind a successful cwd change", async () => {
  let sent = "";
  const channel = new Channel();
  const client = { exec(script: string, callback: Function) { sent = script; callback(null, channel); } } as unknown as Client;
  const pending = exec(client, "printf first; printf second\nprintf third", { cwd: "~/a b" });
  channel.emit("close", 0);
  await pending;
  expect(sent).toBe(`cd "$HOME"/'a b' || exit $?\nprintf first; printf second\nprintf third`);
});

test("SSH timeout settles even when the channel never acknowledges close", async () => {
  const channel = new Channel();
  channel.close = () => { channel.closed = true; };
  const pending = exec(clientFor(channel), "long", { timeoutMs: 5 });
  channel.emit("data", Buffer.from("partial"));
  const result = await Promise.race([pending, Bun.sleep(100).then(() => null)]);
  expect(result).toMatchObject({ exit_code: null, timed_out: true, stdout: "partial" });
  expect(channel.signals).toEqual(["KILL"]);
  expect(channel.closed).toBe(true);
  expect(() => channel.emit("error", new Error("late SSH error"))).not.toThrow();
});

test("synchronous SSH connection failures release cancellation listeners and execution deadlines", async () => {
  for (const execute of [
    (signal: AbortSignal) => exec({ exec() { throw new Error("Not connected"); } } as never, "inspect", { signal, timeoutMs: 5 }),
    (signal: AbortSignal) => sftp({ sftp() { throw new Error("Not connected"); } } as never, signal),
  ]) {
    const control = new AbortController(); let listeners = 0;
    const add = control.signal.addEventListener.bind(control.signal), remove = control.signal.removeEventListener.bind(control.signal);
    control.signal.addEventListener = ((...args: Parameters<typeof add>) => { listeners++; return add(...args); }) as typeof add;
    control.signal.removeEventListener = ((...args: Parameters<typeof remove>) => { listeners--; return remove(...args); }) as typeof remove;
    await expect(execute(control.signal)).rejects.toThrow("Not connected");
    expect(listeners).toBe(0);
  }
});

test("an SFTP error after channel handoff does not escape the tool boundary", async () => {
  const channel = new Channel();
  const client = { sftp(callback: Function) { callback(null, channel); } } as unknown as Client;
  await sftp(client);
  expect(() => channel.emit("error", new Error("SFTP channel failed"))).not.toThrow();
});

test("exec handles cancellation before start, during channel creation and during execution", async () => {
  const early = new AbortController(); early.abort();
  let calls = 0;
  await expect(exec({ exec() { calls++; } } as never, "never", { signal: early.signal })).rejects.toThrow();
  expect(calls).toBe(0);
  let callback: Function;
  const control = new AbortController();
  const pending = exec({ exec(_: string, cb: Function) { callback = cb; } } as never, "late", { signal: control.signal });
  control.abort();
  expect((await pending).cancelled).toBe(true);
  const late = new Channel(); callback!(null, late);
  expect(late.signals).toEqual(["KILL"]); expect(late.closed).toBe(true);
  expect(() => late.emit("error", new Error("channel failed while closing"))).not.toThrow();
  const live = new Channel(), liveControl = new AbortController();
  const livePending = exec(clientFor(live), "live", { signal: liveControl.signal });
  live.emit("data", Buffer.from("partial")); liveControl.abort();
  expect(await livePending).toMatchObject({ cancelled: true, stdout: "partial" });
  live.emit("close", 0);
  expect(live.signals).toEqual(["KILL"]);
});

test("server tools publish resolved target before connecting, preserve errors and distinguish timeout/cancel", async () => {
  let connect = 0;
  const failing = createServerTools({ servers: () => [target], pool: { get: async () => { connect++; throw new Error("offline"); } } as never, sessions: {} as never, workspacePath: ".", onActivity() {} });
  const updates: any[] = [];
  const failed = await failing[0]!.execute("connect", { command: "uptime" }, undefined, value => { expect(connect).toBe(0); updates.push(value); });
  expect(serverOperationInfo(updates[0])).toEqual({ serverId: "a", serverName: "Alpha" });
  expect(failed.isError).toBe(true); expect(serverOperationInfo(failed)).toEqual(serverOperationInfo(updates[0]));
  for (const code of [0, 3]) {
    const channel = new Channel();
    const pending = tools(clientFor(channel))[0]!.execute("exit", { command: "status" }, undefined, undefined);
    await Bun.sleep(0); channel.emit("close", code);
    expect((await pending).isError).toBe(code !== 0);
  }
  const timeout = await exec(clientFor(new Channel()), "timeout", { timeoutMs: 5 });
  expect(timeout.timed_out).toBe(true); expect(timeout.cancelled).not.toBe(true);
  const channel = new Channel(), control = new AbortController();
  const pending = tools(clientFor(channel))[0]!.execute("cancel", { command: "long" }, control.signal, undefined);
  await Bun.sleep(0); channel.emit("data", Buffer.from("keep output")); control.abort();
  const result = await pending;
  expect(serverOperationCancelled(result)).toBe(true);
  expect(JSON.stringify(result.content)).toContain("keep output");
});

test("server_exec preserves the channel error alongside streamed output", async () => {
  const channel = new Channel();
  const pending = tools(clientFor(channel))[0]!.execute("error", { command: "inspect" }, undefined, () => {});
  await Bun.sleep(0);
  channel.emit("data", Buffer.from("partial stdout"));
  await Bun.sleep(115);
  channel.emit("error", new Error("SSH channel lost"));
  const result = await pending;
  expect(result.isError).toBe(true);
  expect(result.content[0]).toEqual({ type: "text", text: JSON.stringify({ error: "SSH channel lost" }) });
  expect(JSON.stringify(result.content)).toContain("partial stdout");
});

test("cancelling an SFTP waiter closes only its eventual channel and leaves pooled work alive", async () => {
  const control = new AbortController(); let callback: Function;
  const pending = sftp({ sftp(cb: Function) { callback = cb; } } as never, control.signal);
  control.abort(); await expect(pending).rejects.toThrow();
  let closed = 0;
  callback!(null, Object.assign(new EventEmitter(), { end() { closed++; } }));
  expect(closed).toBe(1);
  const transfer = new EventEmitter() as any; transfer.end = () => { closed++; transfer.emit("close"); };
  const next = new AbortController();
  await sftp({ sftp(cb: Function) { cb(null, transfer); } } as never, next.signal);
  next.abort(); expect(closed).toBe(2);
  let release: (value: string) => void;
  const shared = new Promise<string>(resolve => { release = resolve; });
  const waiterControl = new AbortController(), waiter = abortable(shared, waiterControl.signal);
  waiterControl.abort(); await expect(waiter).rejects.toThrow(); release!("still reusable");
  expect(await shared).toBe("still reusable");
});

test("nested operation identity and cancelled status survive persisted tool history", () => {
  const db = openDb(":memory:");
  try {
    const session = new SessionRepo(db).create(), run = new RunRepo(db).create(session.id), repo = new ToolCallRepo(db);
    const row = repo.start(run.id, "server_exec", { command: "inspect" }, "nested", "script");
    repo.setServerOperation(row.id, { serverId: target.id, serverName: target.name });
    repo.cancelRun(run.id);
    expect(repo.listBySession(session.id)[0]).toMatchObject({ parentToolCallId: "script", status: "cancelled", serverOperation: JSON.stringify({ serverId: "a", serverName: "Alpha" }) });
  } finally { closeDb(db); }
});


test("cancelled late terminal creation closes only the new channel", async () => {
  let callback: Function;
  const control = new AbortController();
  const sessions = new ServerSessions({ get: async () => ({ shell(_options: unknown, cb: Function) { callback = cb; } }) } as never, () => {});
  const pending = sessions.openTerminal(target, 80, 24, "new", {}, control.signal);
  await Bun.sleep(0); control.abort();
  await expect(pending).rejects.toThrow();
  const channel = new Channel(); callback!(null, channel);
  await Bun.sleep(0); expect(channel.closed).toBe(true); expect(sessions.find("new")).toBeUndefined();
  expect(() => channel.stderr.emit("error", new Error("terminal channel failed while closing"))).not.toThrow();
});

test("a synchronous SSH setup failure closes only the local tunnel socket", async () => {
  const sessions = new ServerSessions({ get() { throw new Error("missing key file"); } } as never, () => {});
  const tunnel = await sessions.openTunnel(target, 80, "http");
  const socket = createConnection({ host: "127.0.0.1", port: tunnel.localPort });
  try {
    expect(await once(socket, "close")).toEqual([false]);
    expect(sessions.tunnelList()).toEqual([tunnel]);
  } finally { socket.destroy(); sessions.closeTunnel(target.id, tunnel.localPort); }
});


test("Pi Code Mode forwards resolved nested server metadata, output updates and parent identity", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai/providers/faux");
  const { PiAdapter } = await import("../src/pi-adapter");
  const provider = fauxProvider({ provider: "server-operation-flow", models: [{ id: "test" }] });
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: 'return await tools.server_exec({command: "uptime"});' })),
    fauxAssistantMessage(fauxText("done")),
  ]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false }); runtime.registerNativeProvider(provider.provider);
  const events: any[] = [], hooks: any[] = [];
  const client = { exec(_command: string, callback: Function) {
    const channel = new Channel(); callback(null, channel);
    setTimeout(() => channel.emit("data", Buffer.from("live output")), 0);
    setTimeout(() => channel.emit("close", 0), 140);
  } } as never;
  const adapter = new PiAdapter(event => events.push(event), { serverTools: () => tools(client), onTool: (...args) => hooks.push(args) });
  Object.assign(adapter, { modelRuntime: runtime });
  try {
    await adapter.run("server-flow", "inspect", { model: "server-operation-flow/test", cwd: process.cwd(), permissionMode: "full", serverIds: ["a"] }, () => {});
    const start = events.find(event => event.type === "tool.started" && event.payload?.toolName === "server_exec");
    expect(start.payload.parentToolCallId).toBeTruthy();
    const updates = events.filter(event => event.type === "tool.updated" && event.payload?.toolName === "server_exec");
    expect(updates.some(event => serverOperationInfo(event.payload.update)?.serverId === "a")).toBe(true);
    expect(updates.some(event => JSON.stringify(event.payload.update).includes("live output"))).toBe(true);
    expect(hooks.some(args => args[2] === "update" && serverOperationInfo(args[5])?.serverId === "a")).toBe(true);
    const end = events.find(event => event.type === "tool.completed" && event.payload?.toolName === "server_exec");
    expect(serverOperationInfo(end.payload.result)?.serverId).toBe("a");
  } finally { await adapter.disposeSession("server-flow"); }
});

test("Code Mode resolves a non-zero server exit to its result instead of failing the whole script", async () => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall, fauxText } = await import("@earendil-works/pi-ai/providers/faux");
  const { PiAdapter } = await import("../src/pi-adapter");
  const provider = fauxProvider({ provider: "server-exit-flow", models: [{ id: "test" }] });
  let scriptResult: any;
  provider.setResponses([
    fauxAssistantMessage(fauxToolCall("codemode", { code: 'const [bad, good] = await Promise.all([tools.server_exec({command: "grep missing"}), tools.server_exec({command: "uptime"})]); return [bad.exit_code, bad.stderr, good.exit_code, good.stdout];' })),
    (context) => { scriptResult = context.messages.at(-1); return fauxAssistantMessage(fauxText("done")); },
  ]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false }); runtime.registerNativeProvider(provider.provider);
  const client = { exec(command: string, callback: Function) {
    const channel = new Channel(); callback(null, channel);
    const failed = command.includes("grep");
    setTimeout(() => { (failed ? channel.stderr : channel).emit("data", Buffer.from(failed ? "no match" : "up 3 days")); channel.emit("close", failed ? 1 : 0); }, 0);
  } } as never;
  const adapter = new PiAdapter(() => {}, { serverTools: () => tools(client) });
  Object.assign(adapter, { modelRuntime: runtime });
  try {
    await adapter.run("server-exit-flow", "inspect", { model: "server-exit-flow/test", cwd: process.cwd(), permissionMode: "full", serverIds: ["a"] }, () => {});
    expect(scriptResult).toMatchObject({ role: "toolResult", toolName: "codemode", isError: false, details: { calls: [{ name: "server_exec", status: "error" }, { name: "server_exec", status: "ok" }] } });
    expect(JSON.stringify(scriptResult.content)).toContain(JSON.stringify([1, "no match", 0, "up 3 days"]).replaceAll('"', '\\"'));
  } finally { await adapter.disposeSession("server-exit-flow"); }
});

test.each(["stop", "forceStop"] as const)("Pi %s preserves a nested server command's last output and cancelled identity", async stopMethod => {
  const { ModelRuntime } = await import("@earendil-works/pi-coding-agent");
  const { fauxProvider, fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai/providers/faux");
  const { PiAdapter } = await import("../src/pi-adapter");
  const provider = fauxProvider({ provider: "server-cancel-flow", models: [{ id: "test" }] });
  provider.setResponses([fauxAssistantMessage(fauxToolCall("codemode", { code: 'return await tools.server_exec({command: "watch"});' }))]);
  const runtime = await ModelRuntime.create({ refreshOnCreate: false, allowModelNetwork: false }); runtime.registerNativeProvider(provider.provider);
  const events: any[] = [];
  let outputReady!: () => void;
  const ready = new Promise<void>(resolve => { outputReady = resolve; });
  const channel = new Channel();
  const client = { exec(_command: string, callback: Function) {
    callback(null, channel);
    setTimeout(() => channel.emit("data", Buffer.from("keep this output")), 0);
  } } as never;
  const adapter = new PiAdapter(event => {
    events.push(event);
    if (event.type === "tool.updated" && JSON.stringify(event.payload).includes("keep this output")) outputReady();
  }, { serverTools: () => tools(client) });
  Object.assign(adapter, { modelRuntime: runtime });
  const run = adapter.run("server-cancel", "watch", { runId: "cancel-run", model: "server-cancel-flow/test", cwd: process.cwd(), permissionMode: "full", serverIds: ["a"] }, () => {}).catch(error => error);
  try {
    await ready;
    expect(adapter[stopMethod]("cancel-run")).toBe(true);
    await run;
    const end = events.find(event => ["tool.completed", "tool.failed"].includes(event.type) && event.payload?.toolName === "server_exec");
    expect(serverOperationInfo(end?.payload.result)?.serverId).toBe("a");
    expect(serverOperationCancelled(end?.payload.result)).toBe(true);
    expect(JSON.stringify(end?.payload.result)).toContain("keep this output");
    expect(channel.signals).toEqual(["KILL"]);
  } finally { adapter.stop("cancel-run"); await adapter.disposeSession("server-cancel"); }
}, 10_000);

test("forced-stop finalization persists each active server snapshot once and ignores retired events", async () => {
  const { subscribeSessionEvents } = await import("../src/pi-session-events");
  let listener!: (event: any) => void;
  const session = { subscribe(callback: typeof listener) { listener = callback; } };
  const events: any[] = [], hooks: any[] = [];
  const finalize = subscribeSessionEvents({ sessionId: "s", eventSessionId: "parent", session, runs: new Map([["run", session]]), activeRunIds: new Map([["s", "run"]]), toolNameByModelName: new Map(),
    hooks: { onTool: (...args) => hooks.push(args) }, push: (type, payload) => events.push({ type, payload }) });
  for (const id of ["a", "b"]) listener({ type: "tool_execution_update", toolName: "resolved-tool", toolCallId: id, parentToolCallId: "script", partialResult: {
    content: [{ type: "text", text: `last ${id}` }], details: { serverOperation: { serverId: id, serverName: id } } } });
  finalize("wrong-run"); expect(events).toHaveLength(2);
  finalize("run");
  const endings = events.filter(event => event.type === "tool.failed");
  expect(endings).toHaveLength(2);
  expect(endings.map(event => event.payload.result.content[0].text)).toEqual(["last a", "last b"]);
  expect(endings.every(event => serverOperationCancelled(event.payload.result) && event.payload.parentToolCallId === "script")).toBe(true);
  expect(hooks.filter(args => args[2] === "end")).toHaveLength(2);
  finalize("run");
  listener({ type: "tool_execution_end", toolCallId: "a", toolName: "resolved-tool", result: { content: [{ type: "text", text: "late success" }] } });
  listener({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "late text" } });
  expect(events).toHaveLength(4); expect(hooks).toHaveLength(4);
});

test("generic framework tool errors retain the resolved server snapshot in events and persistence hooks", async () => {
  const { subscribeSessionEvents } = await import("../src/pi-session-events");
  let listener!: (event: any) => void;
  const session = { subscribe(callback: typeof listener) { listener = callback; } };
  const events: any[] = [], hooks: any[] = [];
  subscribeSessionEvents({ sessionId: "session", eventSessionId: "session", session, runs: new Map([["run", session]]), activeRunIds: new Map([["session", "run"]]), toolNameByModelName: new Map(),
    hooks: { onTool: (...args) => hooks.push(args) }, push: (type, payload) => events.push({ type, payload }) });
  const previous = { content: [{ type: "text", text: '{"stdout":"last output","stderr":"warning"}' }], details: { serverOperation: { serverId: "a", serverName: "Alpha" } } };
  listener({ type: "tool_execution_update", toolName: "resolved-operation", toolCallId: "call", partialResult: previous });
  listener({ type: "tool_execution_end", toolName: "resolved-operation", toolCallId: "call", isError: true, result: { content: [{ type: "text", text: "Aborted" }], details: { cancelled: true } } });
  expect(events.at(-1)).toMatchObject({ type: "tool.failed", payload: { result: { content: previous.content, isError: true, details: { ...previous.details, cancelled: true } } } });
  expect(hooks.at(-1)[5]).toEqual(events.at(-1).payload.result);
  listener({ type: "agent_end" });
  listener({ type: "tool_execution_end", toolName: "other", toolCallId: "call", result: { content: [] } });
  expect(events.at(-1).payload.result).toEqual({ content: [] });
});
