import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { exposedGlobals, installElectronMock, rendererListeners } from "./helpers/electron-mock";

// Real business chain: preload → ipcMain/ipcRenderer → SidecarManager → the
// actual agent-runtime process over stdio NDJSON. Only Electron's native
// boundary is stubbed; every Qone module below is the real one.
installElectronMock();

const dataDir = mkdtempSync(path.join(os.tmpdir(), "qone-electron-chain-"));
const workspaceDir = mkdtempSync(path.join(os.tmpdir(), "qone-electron-workspace-"));
const previousDataDir = process.env.QONE_DATA_DIR;
const previousRuntime = process.env.QONE_AGENT_RUNTIME;
process.env.QONE_DATA_DIR = dataDir;
process.env.QONE_AGENT_RUNTIME = path.resolve(import.meta.dir, "../../agent-runtime/src/index.ts");

// The preload module reads `window` at import time.
const previousWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const fakeWindow: Record<string, unknown> = {};
Object.defineProperty(globalThis, "window", { configurable: true, value: fakeWindow });

await import("../electron/preload");
const bridge = exposedGlobals.electronBridge as {
  invoke: (cmd: string, args?: Record<string, unknown>) => Promise<unknown>;
  listen: (event: string, callback: (event: { payload: unknown }) => void) => Promise<() => void>;
};
fakeWindow.electronBridge = bridge;

const { SidecarManager } = await import("../electron/sidecar");
const { TerminalManager } = await import("../electron/terminal-manager");
const { createDockTerminalSession } = await import("../src/lib/dock-terminal-session");
const { registerIpcHandlers } = await import("../electron/ipc-handlers");

const received: unknown[] = [];
const browserWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: unknown) => {
      if (channel === "runtime-event") received.push(payload);
      for (const listener of rendererListeners.get(channel) ?? []) listener({}, payload);
    },
  },
};

const sidecar = new SidecarManager(() => browserWindow as never);
const terminal = new TerminalManager(() => browserWindow as never);
registerIpcHandlers(() => browserWindow as never, sidecar, terminal, {} as never);

let unsubscribe: (() => void) | undefined;
const events: Record<string, unknown>[] = [];
const waiters: { predicate: (event: Record<string, unknown>) => boolean; resolve: (event: Record<string, unknown>) => void; timer: ReturnType<typeof setTimeout> }[] = [];

function dispatch(payload: unknown) {
  const batch = Array.isArray(payload) ? payload : [payload];
  for (const item of batch) {
    let event: Record<string, unknown>;
    if (typeof item === "string") {
      try { event = JSON.parse(item) as Record<string, unknown>; } catch { continue; }
    } else if (item && typeof item === "object") event = item as Record<string, unknown>;
    else continue;
    events.push(event);
    for (const waiter of [...waiters]) {
      if (!waiter.predicate(event)) continue;
      waiters.splice(waiters.indexOf(waiter), 1);
      clearTimeout(waiter.timer);
      waiter.resolve(event);
    }
  }
}

function nextEvent(predicate: (event: Record<string, unknown>) => boolean, label: string, timeoutMs = 20_000) {
  const existing = events.find(predicate);
  if (existing) return Promise.resolve(existing);
  return new Promise<Record<string, unknown>>((resolve, reject) => {
    const waiter = { predicate, resolve, timer: setTimeout(() => {
      waiters.splice(waiters.indexOf(waiter), 1);
      reject(new Error(`timed out waiting for ${label}`));
    }, timeoutMs) };
    waiters.push(waiter);
  });
}

const send = (command: Record<string, unknown>) => bridge.invoke("runtime_send", { cmd: JSON.stringify(command) });

beforeAll(async () => {
  // The preload listener forwards to `dispatch`; keep a real subscription path.
  unsubscribe = await bridge.listen("runtime-event", (event) => dispatch(event.payload));
  await sidecar.start();
});

afterAll(async () => {
  sidecar.stop();
  unsubscribe?.();
  // The killed runtime releases its SQLite handles asynchronously on Windows.
  for (let attempt = 0; attempt < 40; attempt++) {
    try { rmSync(dataDir, { recursive: true, force: true }); break; }
    catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
  }
  rmSync(workspaceDir, { recursive: true, force: true });
  if (previousDataDir === undefined) delete process.env.QONE_DATA_DIR;
  else process.env.QONE_DATA_DIR = previousDataDir;
  if (previousRuntime === undefined) delete process.env.QONE_AGENT_RUNTIME;
  else process.env.QONE_AGENT_RUNTIME = previousRuntime;
  // Leave the global window exactly as this file found it.
  if (previousWindow) Object.defineProperty(globalThis, "window", previousWindow);
  else Reflect.deleteProperty(globalThis, "window");
});

test("renderer ping travels through preload IPC and the real runtime sidecar", async () => {
  await send({ type: "ping", requestId: "chain-ping" });
  const pong = await nextEvent((event) => event.type === "pong" && event.requestId === "chain-ping", "pong");
  expect(String(pong.capabilities)).toContain("session.snapshot");
  expect(received.length).toBeGreaterThan(0);
}, 30_000);

test("workspace, session and snapshot commands round-trip over the real stdio protocol", async () => {
  await send({ type: "workspace.upsert", requestId: "chain-ws", name: "Chain", path: workspaceDir });
  const workspace = await nextEvent((event) => event.type === "workspace.updated", "workspace.updated") as {
    workspace: { id: string; path: string };
  };
  expect(workspace.workspace.path.toLowerCase()).toBe(path.resolve(workspaceDir).toLowerCase());

  await send({ type: "session.create", requestId: "chain-session", title: "Chain", workspaceId: workspace.workspace.id });
  const created = await nextEvent((event) => event.type === "session.created", "session.created") as {
    session: { id: string };
  };

  await send({ type: "session.messages", requestId: "chain-messages", sessionId: created.session.id });
  const messages = await nextEvent((event) =>
    event.type === "session.messages" && event.sessionId === created.session.id, "session.messages");
  expect(messages.messages).toEqual([]);
}, 30_000);

test("the dock terminal starts a real shell through preload IPC with separate executable and arguments", async () => {
  const terminalId = `terminal-${crypto.randomUUID()}`;
  const marker = `qone-shell-${crypto.randomUUID()}`;
  const chunks: string[] = [];
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const output = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error(`shell output timeout: ${chunks.join("")}`)), 15_000);
  const session = createDockTerminalSession({
    terminalId, cwd: workspaceDir, dimensions: () => ({ cols: 100, rows: 30 }),
    invoke: bridge.invoke,
    listen: async (callbacks) => {
      const offData = await bridge.listen("terminal:data", (event) => {
        const payload = event.payload as { terminalId: string; data: string };
        if (payload.terminalId === terminalId) callbacks.data(payload.data);
      });
      const offExit = await bridge.listen("terminal:exit", (event) => {
        if ((event.payload as { terminalId: string }).terminalId === terminalId) callbacks.exit();
      });
      return () => { offData(); offExit(); };
    },
    output: data => {
      chunks.push(data);
      if (chunks.join("").includes(marker)) ready();
      if (data.includes("[terminal error:")) fail(new Error(data));
    },
  });
  let child: import("node:child_process").ChildProcess | undefined;
  try {
    await session.start();
    child = (terminal as unknown as { sessions: Map<string, { process: import("node:child_process").ChildProcess }> }).sessions.get(terminalId)?.process;
    expect(child?.pid).toBeGreaterThan(0);
    session.write(`Write-Output ('qone-' + 'shell-${marker.slice("qone-shell-".length)}')\r\n`);
    await output;
    expect(session.getSnapshot().status).toBe("ready");
    expect(chunks.join("")).toContain(marker);
  } finally {
    clearTimeout(timer);
    await session.dispose();
    if (child && child.exitCode === null && child.signalCode === null) await new Promise<void>(resolve => child!.once("close", () => resolve()));
  }
  expect((terminal as unknown as { sessions: Map<string, unknown> }).sessions.size).toBe(0);
}, 30_000);

test("restarting the real sidecar joins the old process tree before accepting commands", async () => {
  const oldChild = (sidecar as unknown as { child: import("node:child_process").ChildProcess }).child;
  const oldPid = oldChild.pid;
  await bridge.invoke("runtime_restart");
  const child = (sidecar as unknown as { child: import("node:child_process").ChildProcess }).child;
  expect(child.pid).not.toBe(oldPid);
  expect(oldChild.exitCode !== null || oldChild.signalCode !== null).toBe(true);
  await send({ type: "ping", requestId: "chain-restarted" });
  const pong = await nextEvent((event) => event.type === "pong" && event.requestId === "chain-restarted", "restarted pong");
  expect(String(pong.capabilities)).toContain("session.snapshot");
}, 30_000);

test("no credential-bearing event reaches the renderer and unknown commands still answer", async () => {
  await send({ type: "no.such.command", requestId: "chain-unknown" });
  const failure = await nextEvent((event) => event.type === "error" && event.requestId === "chain-unknown", "unsupported command error");
  expect(String(failure.message)).toContain("invalid or unsupported command");

  const serialized = JSON.stringify(events) + JSON.stringify(received);
  expect(serialized).not.toContain("accessToken");
  expect(serialized).not.toContain("mcp.oauth.token");
}, 30_000);