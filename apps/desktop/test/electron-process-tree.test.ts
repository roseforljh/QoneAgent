import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { installElectronMock } from "./helpers/electron-mock";

// The main process must not leak the runtime's grandchildren when the sidecar
// restarts, nor a shell's children when a dock terminal closes. Windows is the
// case that needs a tree walk: a plain child.kill() leaves them running.
installElectronMock();

const { SidecarManager } = await import("../electron/sidecar");
const { TerminalManager } = await import("../electron/terminal-manager");

const marker = () => `qone-leak-${crypto.randomUUID()}`;

/** Processes whose command line still carries the marker, excluding this query. */
async function liveProcesses(tag: string): Promise<number[]> {
  const script = `Get-CimInstance Win32_Process -Filter "Name='powershell.exe' OR Name='pwsh.exe' OR Name='bun.exe' OR Name='node.exe'" | Where-Object { $_.CommandLine -like '*${tag}*' -and $_.CommandLine -notlike '*Get-CimInstance*' } | Select-Object -ExpandProperty ProcessId`;
  const child = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", script], { stdout: "pipe", stderr: "ignore" });
  const text = await new Response(child.stdout).text();
  await child.exited;
  return text.split(/\s+/).map(Number).filter((value) => Number.isInteger(value) && value > 0);
}

async function waitForNoProcesses(tag: string, timeoutMs = 15_000): Promise<number[]> {
  const deadline = Date.now() + timeoutMs;
  let remaining = await liveProcesses(tag);
  while (remaining.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 150));
    remaining = await liveProcesses(tag);
  }
  return remaining;
}

test("stopping the sidecar kills the runtime it spawned through its wrapper", async () => {
  const directory = mkdtempSync(path.join(os.tmpdir(), "qone-sidecar-tree-"));
  const tag = marker();
  const previous = process.env.QONE_AGENT_RUNTIME;
  // A wrapper script that spawns a grandchild, like `bun run` does.
  const entry = path.join(directory, "wrapper.ts");
  await Bun.write(entry, `const child = Bun.spawn(["powershell.exe", "-NoProfile", "-Command", "Start-Sleep -Seconds 120 # ${tag}"], { stdout: "ignore" });\nawait child.exited;\n`);
  process.env.QONE_AGENT_RUNTIME = entry;
  const sidecar = new SidecarManager(() => null);
  try {
    await sidecar.start();
    const deadline = Date.now() + 15_000;
    let started = await liveProcesses(tag);
    while (!started.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      started = await liveProcesses(tag);
    }
    expect(started.length).toBeGreaterThan(0);
    sidecar.stop();
    expect(await waitForNoProcesses(tag)).toEqual([]);
  } finally {
    sidecar.stop();
    if (previous === undefined) delete process.env.QONE_AGENT_RUNTIME;
    else process.env.QONE_AGENT_RUNTIME = previous;
    for (let attempt = 0; attempt < 40; attempt++) {
      try { rmSync(directory, { recursive: true, force: true }); break; }
      catch { await new Promise((resolve) => setTimeout(resolve, 100)); }
    }
  }
}, 60_000);

test("killing a dock terminal kills the shell's children", async () => {
  const terminal = new TerminalManager(() => null);
  const directory = mkdtempSync(path.join(os.tmpdir(), "qone-terminal-tree-"));
  const tag = marker();
  try {
    terminal.spawn("tree", "powershell.exe", undefined, 120, 30, ["-NoProfile", "-NoExit", "-Command", `Set-PSReadLineOption -HistorySavePath '${path.join(directory, "history.txt").replaceAll("'", "''")}'`]);
    // The spawned shell starts a grandchild carrying the marker.
    terminal.write("tree", `Start-Process -FilePath powershell.exe -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 120 # ${tag}'\r`);
    const deadline = Date.now() + 15_000;
    let started = await liveProcesses(tag);
    while (!started.length && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 150));
      started = await liveProcesses(tag);
    }
    expect(started.length).toBeGreaterThan(0);
    terminal.kill("tree");
    expect(await waitForNoProcesses(tag)).toEqual([]);
  } finally {
    await terminal.kill("tree");
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
