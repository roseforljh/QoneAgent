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
const { registerIpcHandlers } = await import("../electron/ipc-handlers");

const received: unknown[] = [];
const browserWindow = {
  isDestroyed: () => false,
  webContents: {
    send: (channel: string, payload: unknown) => {
      if (channel !== "runtime-event") return;
      // The main process sends batches (arrays) or single events.
      received.push(payload);
      for (const listener of rendererListeners.get(channel) ?? []) listener({}, payload);
    },
  },
};

const sidecar = new SidecarManager(() => browserWindow as never);
registerIpcHandlers(() => browserWindow as never, sidecar, {} as never, {} as never);

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
  sidecar.start();
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

test("no credential-bearing event reaches the renderer and unknown commands still answer", async () => {
  await send({ type: "no.such.command", requestId: "chain-unknown" });
  const failure = await nextEvent((event) => event.type === "error" && event.requestId === "chain-unknown", "unsupported command error");
  expect(String(failure.message)).toContain("invalid or unsupported command");

  const serialized = JSON.stringify(events) + JSON.stringify(received);
  expect(serialized).not.toContain("accessToken");
  expect(serialized).not.toContain("mcp.oauth.token");
}, 30_000);