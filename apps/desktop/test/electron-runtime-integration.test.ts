import { afterAll, beforeAll, expect, test } from "bun:test";
import { once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Terminal as Xterm } from "@xterm/xterm";
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
  let releasePath!: () => void;
  const pathReady = new Promise<void>((resolve) => { releasePath = resolve; });
  const started = sidecar.start(pathReady);
  // Production pages can ping before the asynchronous registry read finishes.
  const firstPing = send({ type: "ping", requestId: "chain-early-ping" });
  expect((sidecar as unknown as { child: unknown }).child).toBeNull();
  releasePath();
  await Promise.all([started, firstPing]);
  await nextEvent((event) => event.type === "pong" && event.requestId === "chain-early-ping", "early pong");
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

test("sidecar pipe errors stay local and the renderer can start a replacement", async () => {
  const { child } = sidecar as unknown as { child: ChildProcess };
  const closed = once(child, "close");
  child.stdin!.destroy(Object.assign(new Error("test closed input pipe"), { code: "EPIPE" }));
  child.stdout!.destroy(Object.assign(new Error("test closed output pipe"), { code: "EPIPE" }));
  try {
    await expect(send({ type: "ping", requestId: "chain-broken-pipe" })).rejects.toThrow("agent runtime is not running");
  } finally { child.kill(); await closed; }
  await nextEvent((event) => event.type === "runtime.exited", "runtime exit notice");
  await bridge.invoke("runtime_restart");
  await send({ type: "ping", requestId: "chain-restarted" });
  await nextEvent((event) => event.type === "pong" && event.requestId === "chain-restarted", "replacement pong");
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
  const { preparePSReadLine } = await import("../scripts/prepare-psreadline");
  await preparePSReadLine();
  const terminalId = `terminal-${crypto.randomUUID()}`;
  const marker = `qone-shell-${crypto.randomUUID()}`;
  const chunks: string[] = [];
  const screen = new Xterm({ cols: 100, rows: 30, windowsPty: { backend: "conpty" }, reflowCursorLine: true });
  const lines = () => Array.from({ length: screen.buffer.active.length }, (_, index) => screen.buffer.active.getLine(index)!.translateToString(true).trimEnd());
  let ready!: () => void;
  let fail!: (error: Error) => void;
  const output = new Promise<void>((resolve, reject) => { ready = resolve; fail = reject; });
  const timer = setTimeout(() => fail(new Error(`shell output timeout: ${chunks.join("")}`)), 15_000);
  let dimensions = { cols: 100, rows: 30 };
  const session = createDockTerminalSession({
    terminalId, cwd: workspaceDir, dimensions: () => dimensions,
    invoke: (command, args) => bridge.invoke(command, command === "terminal_spawn" ? {
      ...args, shellArgs: ["-NoProfile", "-NoExit", "-Command", `Set-PSReadLineOption -HistorySavePath '${path.join(dataDir, "terminal-history.txt").replaceAll("'", "''")}' -PredictionSource History`],
    } : args),
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
      screen.write(data, () => {
        if (lines().includes(`${marker}-next`)) ready();
      });
      if (data.includes("[terminal error:")) fail(new Error(data));
    },
  });
  const responses = screen.onData(session.write);
  // Same order as the dock: parse output already received at the old size,
  // then resize xterm and the pseudo console.
  const resize = async (cols: number, rows: number) => {
    await new Promise<void>((resolve) => screen.write("", resolve));
    dimensions = { cols, rows };
    screen.resize(cols, rows);
    session.resize();
  };
  let exited: Promise<void> | undefined;
  try {
    await session.start();
    const child = (terminal as unknown as { sessions: Map<string, { process: import("node-pty").IPty }> }).sessions.get(terminalId)?.process;
    const started = Date.now() + 5_000;
    while (!child?.pid && Date.now() < started) await Bun.sleep(20);
    expect(child?.pid).toBeGreaterThan(0);
    exited = new Promise<void>((resolve) => child!.onExit(() => resolve()));
    expect([child!.cols, child!.rows]).toEqual([100, 30]);
    await resize(88, 26);
    session.write(`Write-Output ('qone-' + 'shell-${marker.slice("qone-shell-".length)}'); Write-Output '中文第二行'; Write-Output ('qone-' + 'shell-${marker.slice("qone-shell-".length)}-next')\r`);
    await output;
    expect(session.getSnapshot().status).toBe("ready");
    expect([child!.cols, child!.rows]).toEqual([88, 26]);
    session.write(`Write-Output ('qone-' + 'shell-${marker.slice("qone-shell-".length)}-again')\r`);
    const deadline = Date.now() + 5_000;
    expect(lines().slice(lines().indexOf(marker), lines().indexOf(marker) + 3)).toEqual([marker, "中文第二行", `${marker}-next`]);
    while (!lines().includes(`${marker}-again`) && Date.now() < deadline) await Bun.sleep(20);
    expect(lines()).toContain(`${marker}-again`);
    // Prediction draws below the input on narrow terminals. It must be erased
    // when a shorter command is submitted, without leaving suggested text.
    session.write("Write-Output ");
    const predicted = Date.now() + 5_000;
    const promptText = `PS ${workspaceDir}>`;
    const promptRow = () => lines().findLastIndex((line, index, all) => line.startsWith("PS ") && all.slice(index).join("").startsWith(promptText));
    const prediction = `shell-${marker.slice("qone-shell-".length)}-again`;
    const inputDrawn = (text: string) => {
      const buffer = screen.buffer.active;
      let row = buffer.baseY + buffer.cursorY;
      let beforeCursor = buffer.getLine(row)!.translateToString(false, 0, buffer.cursorX);
      while (row > 0 && buffer.getLine(row)!.isWrapped) beforeCursor = buffer.getLine(--row)!.translateToString(false) + beforeCursor;
      return beforeCursor.endsWith(text);
    };
    while ((!inputDrawn("Write-Output ") || !lines().slice(promptRow()).join("").includes(prediction)) && Date.now() < predicted) await Bun.sleep(20);
    expect(inputDrawn("Write-Output ")).toBe(true);
    expect(lines().slice(promptRow()).join("")).toContain(prediction);
    // Resize and submit immediately after the input was drawn: no grace period.
    await resize(72, 26);
    session.write("'own'\r");
    const cleared = Date.now() + 5_000;
    while (!lines().includes("own") && Date.now() < cleared) await Bun.sleep(20);
    expect(lines()).toContain("own");
    const prompt = lines().findLastIndex((line) => line.startsWith(`PS ${workspaceDir}>`));
    expect(lines().slice(prompt + 1).every((line) => line === "")).toBe(true);

    // Submit an already-drawn command with Enter alone, immediately after
    // shrinking or expanding; this exercises AcceptLine without another render key.
    for (const [attempt, cols] of [60, 100, 60, 100, 60, 100].entries()) {
      const result = `直接回车-${cols}-${attempt}`;
      const text = `Write-Output '${result}'`;
      session.write(text);
      const drawn = Date.now() + 5_000;
      while (!inputDrawn(text) && Date.now() < drawn) await Bun.sleep(1);
      expect(inputDrawn(text)).toBe(true);
      await resize(cols, 26);
      session.write("\r");
      const accepted = Date.now() + 5_000;
      const promptLines = Math.ceil(promptText.length / cols);
      const promptFinished = () => promptRow() > lines().indexOf(result) && lines().slice(promptRow(), promptRow() + promptLines).join("") === promptText;
      // Output and the next prompt arrive in separate VT chunks; wait for the
      // redraw to finish, not just the prompt prefix over the previous render.
      while ((!lines().includes(result) || !promptFinished()) && Date.now() < accepted) await Bun.sleep(20);
      expect(lines()).toContain(result);
      const nextPrompt = promptRow();
      expect(nextPrompt).toBeGreaterThan(lines().indexOf(result));
      expect(lines().slice(nextPrompt, nextPrompt + promptLines).join("")).toBe(promptText);
      expect(lines().slice(nextPrompt + promptLines).every((line) => line === "")).toBe(true);
    }

    await bridge.invoke("terminal_clear", { terminalId });
    screen.clear();
    await resize(96, 26);
    session.write("Write-Output 'cleared'\r");
    const clearing = Date.now() + 5_000;
    while (!lines().includes("cleared") && Date.now() < clearing) await Bun.sleep(20);
    expect(lines()).toContain("cleared");
    expect(lines()).not.toContain(marker);
    expect(lines()).not.toContain(`${marker}-again`);
  } finally {
    clearTimeout(timer);
    await session.dispose();
    if (exited) await Promise.race([exited, Bun.sleep(5_000).then(() => { throw new Error("PTY did not exit after disposal"); })]);
    responses.dispose();
    screen.dispose();
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