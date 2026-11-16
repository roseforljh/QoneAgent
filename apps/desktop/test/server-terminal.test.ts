import { expect, test } from "bun:test";
import type { RuntimeCommand } from "@qone/protocol";
import { createDockTerminalSession } from "../src/lib/dock-terminal-session";
import { dispatchServerTerminal, dispatchServerTerminalError, serverTerminalTransport } from "../src/lib/server-terminal";

test("an SSH dock terminal maps the local PTY lifecycle onto runtime commands", async () => {
  const sent: RuntimeCommand[] = [];
  const output: string[] = [];
  const send = async (command: RuntimeCommand) => {
    sent.push(command);
    if (command.type === "server.terminal.open") queueMicrotask(() => dispatchServerTerminal({ type: "server.terminal.opened", requestId: command.requestId, terminalId: command.terminalId }));
    return true;
  };
  const session = createDockTerminalSession({
    terminalId: "dock-t1", cwd: "", dimensions: () => ({ cols: 100, rows: 30 }), output: (data) => output.push(data),
    ...serverTerminalTransport("srv-1", "dock-t1", send),
  });
  session.write("early");
  await session.start();
  expect(session.getSnapshot().status).toBe("ready");
  expect(sent[0]).toMatchObject({ type: "server.terminal.open", serverId: "srv-1", terminalId: "dock-t1", cols: 100, rows: 30 });
  await Bun.sleep(0);
  expect(sent.find((command) => command.type === "server.terminal.write")).toMatchObject({ data: "early" });
  dispatchServerTerminal({ type: "server.terminal.data", terminalId: "dock-t1", data: "$ " });
  dispatchServerTerminal({ type: "server.terminal.data", terminalId: "other", data: "x" });
  expect(output).toEqual(["$ "]);
  dispatchServerTerminal({ type: "server.terminal.exit", terminalId: "dock-t1" });
  expect(session.getSnapshot().status).toBe("exited");
  await session.dispose();
  expect(sent.at(-1)).toMatchObject({ type: "server.terminal.close", terminalId: "dock-t1" });
});

test("a rejected SSH terminal open surfaces as a terminal error", async () => {
  const session = createDockTerminalSession({
    terminalId: "dock-t2", cwd: "", dimensions: () => ({ cols: 80, rows: 24 }), output: () => {},
    ...serverTerminalTransport("srv-1", "dock-t2", async (command) => {
      if (command.type === "server.terminal.open") queueMicrotask(() => dispatchServerTerminalError(command.requestId, "连不上"));
      return true;
    }),
  });
  await session.start();
  expect(session.getSnapshot()).toMatchObject({ status: "error" });
});
