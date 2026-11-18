import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { connect } from "node:net";
import os from "node:os";
import { Terminal } from "@xterm/xterm";
import { windowsPowerShellPath } from "../../electron/system-path";
import { AdministratorTerminalHost } from "../../electron/administrator-terminal-host";
import { terminalPipe } from "../../electron/terminal-pipe";
import { createBrokeredPowerShell } from "../../../agent-runtime/src/elevated-powershell";
import type { ShellHostResponse } from "@qone/protocol/terminal-host";

async function check() {
  const [terminalWorkerBundle, powershellClient] = process.argv.slice(2);
  if (powershellClient === "client") {
    const { elevatedPowerShell } = await import("../../../agent-runtime/src/elevated-powershell");
    assert.ok(elevatedPowerShell);
    try {
      const output: Buffer[] = [];
      assert.deepEqual(await elevatedPowerShell.exec("Write-Output 'ipc-shell'", os.tmpdir(), { onData: data => output.push(data) }), { exitCode: 0 });
      process.stdout.write(Buffer.concat(output));
    } finally { process.disconnect?.(); }
    return;
  }
  const electron = process.execPath;
  const signal = new AbortController().signal;
  const workers: ReturnType<typeof spawn>[] = [];
  const host = await AdministratorTerminalHost.start(async (pipe, token) => {
    const imposter = connect(terminalPipe(pipe));
    const closed = once(imposter, "close");
    await once(imposter, "connect");
    imposter.write(`${JSON.stringify({ type: "ready", proof: "wrong" })}\n`);
    await closed;
    const worker = spawn(electron, [terminalWorkerBundle, pipe, token], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, stdio: ["ignore", "ignore", "inherit"], windowsHide: true,
    });
    workers.push(worker);
    await once(worker, "spawn");
  }, signal);
  const [worker] = workers;
  const deadline = setTimeout(() => { host.stop(); worker.kill(); }, 15_000);
  const workerExited = once(worker, "exit");
  try {
    assert.equal(host.active, true);
    const client = spawn(electron, [process.argv[1], "", "client"], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1", QONE_ELEVATED_TERMINAL: "1" }, windowsHide: true,
      stdio: ["ignore", "pipe", "inherit", "ipc"],
    });
    client.on("message", (request: import("@qone/protocol/terminal-host").ShellHostRequest) =>
      host.shell(client, request, response => { if (client.connected) client.send(response, () => {}); }));
    client.once("disconnect", () => host.cancelShells(client));
    let clientOutput = "";
    client.stdout!.on("data", data => { clientOutput += String(data); });
    assert.equal((await once(client, "close"))[0], 0);
    assert.equal(clientOutput.trim(), "ipc-shell");

    const owner = {};
    let deliver!: (message: ShellHostResponse) => void;
    const shell = createBrokeredPowerShell((request, callback) => {
      host.shell(owner, request, deliver);
      callback(null);
    }, handler => { deliver = handler; }, () => {});
    const output: Buffer[] = [];
    const exec = (command: string, signal?: AbortSignal) => shell.exec(command, os.tmpdir(), {
      onData: data => output.push(data), timeout: 5, env: { ...process.env, QONE_TEST_TERMINAL_COPY: "中文" }, signal,
    });
    assert.deepEqual(await exec("Write-Output $env:QONE_TEST_TERMINAL_COPY; [Console]::Error.WriteLine('stderr'); exit 7"), { exitCode: 7 });
    assert.deepEqual(await exec("Write-Output 'second command'"), { exitCode: 0 });
    const result = Buffer.concat(output).toString("utf8");
    assert.ok(result.includes("中文"), result);
    assert.ok(result.includes("stderr"), result);
    assert.ok(result.includes("second command"), result);
    await assert.rejects(shell.exec("Start-Sleep -Seconds 15", os.tmpdir(), { onData: () => {}, timeout: 0.5 }), /timeout:0.5/);
    const abort = new AbortController();
    const pending = exec("Start-Sleep -Seconds 15", abort.signal);
    abort.abort();
    await assert.rejects(pending, /aborted/);

    const pty = host.spawnPty(windowsPowerShellPath(), ["-NoProfile"], { cwd: os.tmpdir(), cols: 120, rows: 30, env: { ...process.env, TERM: "xterm-256color" } });
    const xterm = new Terminal({ cols: 100, rows: 24, windowsPty: { backend: "conpty" } });
    xterm.onData(pty.write);
    let screen = "";
    pty.onData(data => { screen += data; xterm.write(data); });
    const exited = new Promise<number>((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error(`PTY did not exit: ${JSON.stringify(screen)}`)), 5000);
      pty.onExit(event => { clearTimeout(timeout); resolve(event.exitCode); });
    });
    pty.resize(100, 24);
    pty.write("Write-Output ('headless-' + 'pty-result'); exit 3\r");
    assert.equal(await exited, 3);
    assert.ok(screen.includes("headless-pty-result"), screen);
    xterm.dispose();
    assert.equal(workers.length, 1);
    const interrupted = exec("Start-Sleep -Seconds 15");
    host.stop();
    await assert.rejects(interrupted, /disconnected/);
    assert.equal((await workerExited)[0], 0);
  } finally {
    clearTimeout(deadline);
    host.stop();
    if (worker.exitCode === null) worker.kill();
  }
}

void check().catch(error => { console.error(error); process.exitCode = 1; });
