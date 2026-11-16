import { expect, test } from "bun:test";
import { installElectronMock } from "./helpers/electron-mock";

installElectronMock();

const { TerminalManager } = await import("../electron/terminal-manager");

// A fake shell process whose lifecycle this test drives by hand, so the
// "old process closes after the id was reopened" race is deterministic.
function fakeShell(pid: number) {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const push = (event: string, fn: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn]);
  };
  const child = {
    pid: undefined, // A fake shell must never taskkill an actual system PID.
    stdin: { destroyed: false, write: () => true },
    stdout: { on: (event: string, fn: (...args: unknown[]) => void) => push(event, fn) },
    stderr: { on: (event: string, fn: (...args: unknown[]) => void) => push(event, fn) },
    on: (event: string, fn: (...args: unknown[]) => void) => push(event, fn),
    kill: () => true,
  };
  return {
    child: child as unknown as import("node:child_process").ChildProcess,
    fire: (event: string, ...args: unknown[]) => { for (const fn of listeners.get(event) ?? []) fn(...args); },
  };
}

function windowStub() {
  const sent: { channel: string; payload: unknown }[] = [];
  return {
    sent,
    isDestroyed: () => false,
    webContents: { send: (channel: string, payload: unknown) => { sent.push({ channel, payload }); } },
  };
}

function managerWith(win: ReturnType<typeof windowStub>, shells: ReturnType<typeof fakeShell>[]) {
  const manager = new TerminalManager(() => win as never, (() => shells.shift()!.child) as never);
  const sessions = (manager as unknown as { sessions: Map<string, unknown> }).sessions;
  return { manager, sessions };
}

test("a late close from the replaced process cannot delete or close the reopened terminal", () => {
  const win = windowStub();
  const first = fakeShell(1);
  const second = fakeShell(2);
  const { manager, sessions } = managerWith(win, [first, second]);
  try {
    manager.spawn("t1");
    manager.spawn("t1");
    expect(sessions.size).toBe(1);

    // The replaced process finally dies after the id was reopened.
    first.fire("close");
    expect(sessions.has("t1")).toBe(true);
    expect(win.sent.filter((event) => event.channel === "terminal:exit")).toEqual([]);
    // Its buffered output must not reach the new terminal's view either.
    first.fire("data", "stale output");
    expect(win.sent.filter((event) => event.channel === "terminal:data")).toEqual([]);

    // The live process still owns the id: its close is reported once.
    second.fire("close");
    expect(sessions.has("t1")).toBe(false);
    expect(win.sent.filter((event) => event.channel === "terminal:exit")).toHaveLength(1);
  } finally {
    manager.killAll();
  }
});

test("kill() drops the session so a late close cannot emit a second exit", () => {
  const win = windowStub();
  const shell = fakeShell(3);
  const { manager, sessions } = managerWith(win, [shell]);
  try {
    manager.spawn("t2");
    manager.kill("t2");
    expect(sessions.has("t2")).toBe(false);
    shell.fire("close");
    expect(win.sent.filter((event) => event.channel === "terminal:exit")).toEqual([]);
  } finally {
    manager.killAll();
  }
});
