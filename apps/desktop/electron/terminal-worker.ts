import { connect } from "node:net";
import { createRequire } from "node:module";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { IPty } from "node-pty";
import type { TerminalHostRequest, TerminalHostResponse } from "@qone/protocol/terminal-host";
import { createLocalPowerShellOperations } from "../../agent-runtime/src/local-powershell-operations";
import { killProcessTree } from "./process-tree";
import { resolveWindowsShell } from "./system-path";
import { sendTerminalMessage, terminalMessages, terminalPipe, terminalProof } from "./terminal-pipe";

// This entry runs in Electron's Node mode. It never initializes the UI, Agent or browser.
const [pipeId, token] = process.argv.slice(2);
if (!/^[a-f0-9]{64}$/.test(pipeId) || !/^[a-f0-9]{64}$/.test(token)) process.exit(1);
const localRequire = createRequire(import.meta.url);
const unpacked = fileURLToPath(new URL("../app.asar.unpacked/node_modules/node-pty", import.meta.url));
const pty = localRequire(existsSync(unpacked) ? unpacked : "node-pty") as typeof import("node-pty");
const shell = createLocalPowerShellOperations();
const commands = new Map<string, AbortController>();
const terminals = new Map<string, IPty>();
const socket = connect(terminalPipe(pipeId));
const send = (message: TerminalHostResponse) => sendTerminalMessage(socket, message);
socket.on("error", () => socket.destroy());
socket.setTimeout(10_000, () => socket.destroy());
socket.once("connect", () => sendTerminalMessage(socket, { type: "ready", proof: terminalProof(token, "worker") }));
socket.once("close", () => {
  for (const command of commands.values()) command.abort();
  for (const terminal of terminals.values()) void killProcessTree(terminal);
  terminals.clear();
});

function terminalExit(id: string, exitCode: number, signal?: number, error?: string) {
  if (terminals.delete(id) || error) send({ type: "pty.exit", id, exitCode, signal, error });
}

function handle(message: TerminalHostRequest) {
  const { id } = message;
  if (typeof id !== "string" || !id) return;
  switch (message.type) {
    case "terminal-host.exec": {
      if (commands.has(id)) return;
      const controller = new AbortController();
      commands.set(id, controller);
      void shell.exec(message.command, message.cwd, {
        env: message.env, signal: controller.signal, timeout: message.timeout,
        onData: data => { send({ type: "terminal-host.output", id, data: data.toString("base64") }); },
      }).then(({ exitCode }) => send({ type: "terminal-host.exit", id, exitCode }), error =>
        send({ type: "terminal-host.error", id, message: error instanceof Error ? error.message : String(error) }),
      ).finally(() => commands.delete(id));
      return;
    }
    case "terminal-host.cancel":
      commands.get(id)?.abort();
      return;
    case "pty.spawn": {
      if (terminals.has(id)) return;
      try {
        const resolvedShell = process.platform === "win32"
          ? resolveWindowsShell(message.shell, message.options.env ?? process.env)
          : message.shell;
        const child = pty.spawn(resolvedShell, message.args, { ...message.options, name: "xterm-256color", useConptyDll: true });
        terminals.set(id, child);
        child.onData(data => { if (terminals.has(id)) send({ type: "pty.data", id, data }); });
        child.onExit(({ exitCode, signal }) => terminalExit(id, exitCode, signal));
      } catch (error) {
        terminalExit(id, 1, undefined, error instanceof Error ? error.message : String(error));
      }
      return;
    }
  }
  const child = terminals.get(id);
  if (!child) return;
  try {
    if (message.type === "pty.write") child.write(message.data);
    if (message.type === "pty.resize") child.resize(message.cols, message.rows);
    if (message.type === "pty.clear") child.clear();
    if (message.type === "pty.kill") {
      terminals.delete(id);
      void killProcessTree(child);
    }
  } catch { /* The shell can exit between a renderer event and dispatch. */ }
}
let accepted = false;
terminalMessages(socket, message => {
  if (accepted) return handle(message);
  if (message?.type !== "accept" || message.proof !== terminalProof(token, "desktop")) { socket.destroy(); return; }
  socket.setTimeout(0);
  accepted = true;
});
