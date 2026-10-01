import { expect, test } from "bun:test";
import { createDockTerminalSession, type TerminalEvents } from "../src/lib/dock-terminal-session";

test("会话切换后复用原 PTY，只有关闭标签才终止进程", async () => {
  const calls: string[] = [];
  let listener: TerminalEvents | undefined;
  const session = createDockTerminalSession({
    terminalId: "dock-tab-a",
    cwd: "C:/project",
    dimensions: () => ({ cols: 80, rows: 24 }),
    invoke: async (command) => { calls.push(command); },
    listen: async (events) => { listener = events; return () => {}; },
    output: () => {},
  });

  await session.start();
  await session.start(); // The tab is still mounted when its conversation is hidden.
  session.write("cd subdir\r");
  await Promise.resolve();
  expect(calls.filter((command) => command === "terminal_spawn")).toHaveLength(1);
  expect(calls).toContain("terminal_write");
  expect(session.getSnapshot().status).toBe("ready");

  listener?.data("still running");
  await session.dispose();
  expect(calls.at(-1)).toBe("terminal_kill");
});

test("创建中的终端被关闭后，排队的 kill 不会漏掉 PTY", async () => {
  let releaseSpawn: (() => void) | undefined;
  const calls: string[] = [];
  const session = createDockTerminalSession({
    terminalId: "dock-tab-pending",
    cwd: "C:/project",
    dimensions: () => ({ cols: 80, rows: 24 }),
    invoke: async (command) => {
      calls.push(command);
      if (command === "terminal_spawn") await new Promise<void>((resolve) => { releaseSpawn = resolve; });
    },
    listen: async () => () => {},
    output: () => {},
  });

  const starting = session.start();
  while (!releaseSpawn) await Promise.resolve();
  const closing = session.dispose();
  releaseSpawn();
  await Promise.all([starting, closing]);
  expect(calls).toEqual(["terminal_spawn", "terminal_kill"]);
});

for (const action of ["dispose", "restart"] as const) test(`${action} can release a blocked write without replaying old input`, async () => {
  const writes: string[] = [];
  let releaseWrite: (() => void) | undefined;
  let kills = 0;
  const session = createDockTerminalSession({
    terminalId: `blocked-${action}`, cwd: "C:/project", dimensions: () => ({ cols: 80, rows: 24 }),
    invoke: async (command, args) => {
      if (command === "terminal_write") {
        writes.push(String(args.data));
        if (args.data === "blocked") await new Promise<void>((resolve) => { releaseWrite = resolve; });
      }
      if (command === "terminal_kill") { kills++; releaseWrite?.(); }
    },
    listen: async () => () => {}, output: () => {},
  });
  await session.start();
  session.write("blocked");
  while (!releaseWrite) await Promise.resolve();
  session.write("old input");
  await session[action]();
  expect(kills).toBe(1);
  expect(writes).toEqual(["blocked"]);
  if (action === "restart") {
    expect(session.getSnapshot().status).toBe("ready");
    session.write("new input");
    await Bun.sleep(20);
    expect(writes).toEqual(["blocked", "new input"]);
    await session.dispose();
  }
});
