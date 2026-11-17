import { expect, mock, test } from "bun:test";
import { installElectronMock } from "./helpers/electron-mock";

installElectronMock();

const { TerminalManager } = await import("../electron/terminal-manager");

// A fake shell process whose lifecycle this test drives by hand, so the
// "old process closes after the id was reopened" race is deterministic.
function fakeShell() {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  const push = (event: string, fn: (...args: unknown[]) => void) => {
    listeners.set(event, [...(listeners.get(event) ?? []), fn]);
  };
  const child = {
    pid: undefined as number | undefined, // A fake shell must never taskkill an actual system PID.
    onData: (fn: (...args: unknown[]) => void) => push("data", fn),
    onExit: (fn: (...args: unknown[]) => void) => push("close", fn),
    write: mock((_data: string) => {}),
    resize: mock((_cols: number, _rows: number) => {}),
    clear: mock(() => {}),
    kill: mock(() => {}),
  };
  return {
    child,
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
  const first = fakeShell();
  const second = fakeShell();
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
  const shell = fakeShell();
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

test("PTY receives shell dimensions, raw input and resize, and preserves VT output", async () => {
  const { preparePSReadLine } = await import("../scripts/prepare-psreadline");
  await preparePSReadLine();
  const win = windowStub();
  const shell = fakeShell();
  const spawn = mock(() => shell.child);
  const manager = new TerminalManager(() => win as never, spawn as never);
  try {
    manager.spawn("pty", "pwsh.exe", "C:/project", 100, 30, ["-NoProfile"]);
    expect(spawn).toHaveBeenCalledWith("pwsh.exe", ["-NoProfile"], expect.objectContaining({
      name: "xterm-256color", cwd: "C:/project", cols: 100, rows: 30,
      env: expect.objectContaining({ TERM: "xterm-256color" }),
    }));
    manager.write("pty", "echo 中文\r");
    expect(shell.child.write).toHaveBeenCalledWith("echo 中文\r");
    manager.resize("pty", 80, 24);
    manager.resize("pty", 0, 0);
    expect(shell.child.resize.mock.calls).toEqual([[80, 24]]);
    manager.clear("pty");
    manager.clear("missing");
    expect(shell.child.clear).toHaveBeenCalledTimes(1);
    shell.fire("data", "\x1b[32m中文\x1b[0m\r\nsecond\r\n");
    expect(win.sent).toEqual([{ channel: "terminal:data", payload: { terminalId: "pty", data: "\x1b[32m中文\x1b[0m\r\nsecond\r\n" } }]);
  } finally { manager.killAll(); }
});
