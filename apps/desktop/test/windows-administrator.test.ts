import { expect, test } from "bun:test";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPowerShellPath } from "../electron/system-path";
import { administratorLaunchEnabled, elevationRequest, setAdministratorLaunchEnabled, tryAdministratorTerminal } from "../electron/windows-administrator";
import { build } from "esbuild";
import { promisify } from "node:util";
import { buildTerminalWorker, terminalWorkerBundle } from "../scripts/build-runtime";

const windows = process.platform === "win32";

test.skipIf(!windows)("terminal elevation is opt-in; a declined startup does not change the preference", async () => {
  const previous = process.env.QONE_DATA_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-administrator-"));
  process.env.QONE_DATA_DIR = root;
  try {
    const signal = new AbortController().signal;
    let launches = 0;
    const launch = async () => { launches++; throw new Error("UAC cancelled"); };
    expect(administratorLaunchEnabled()).toBe(false);
    expect(await tryAdministratorTerminal(import.meta.path, signal, launch)).toBeNull();
    expect(launches).toBe(0);
    setAdministratorLaunchEnabled(true);
    setAdministratorLaunchEnabled(true);
    expect(await tryAdministratorTerminal(import.meta.path, signal, launch)).toBeNull();
    expect(launches).toBe(1);
    expect(administratorLaunchEnabled()).toBe(true);
    setAdministratorLaunchEnabled(false);
    expect(administratorLaunchEnabled()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.QONE_DATA_DIR;
    else process.env.QONE_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(!windows)("the RunAs launcher receives only the encoded headless worker and handles literal paths", () => {
  const directory = path.join(os.tmpdir(), "项目 ‘Windows’ test; (x) [1]");
  const executable = path.join(directory, "Qone Agent.exe");
  const worker = path.join(directory, "resources", "terminal worker.mjs");
  const pipe = "1".repeat(64);
  const token = "2".repeat(64);
  const request = elevationRequest(executable, worker, pipe, token);
  const script = Buffer.from(request.args.at(-1)!, "base64").toString("utf16le");
  expect(script).not.toContain(token);
  const stub = `function Start-Process {
    param($FilePath, $WorkingDirectory, $ArgumentList, $Verb)
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    $cwd = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($WorkingDirectory))
    @{path=$FilePath; cwd=$cwd; args=$ArgumentList; verb=$Verb} | ConvertTo-Json -Compress
  }; `;
  const args = [...request.args.slice(0, -1), Buffer.from(stub + script, "utf16le").toString("base64")];
  const launched = JSON.parse(execFileSync(windowsPowerShellPath(), args, { input: request.input, encoding: "utf8", timeout: 10_000 }));
  expect(launched).toEqual({ path: windowsPowerShellPath(), cwd: Buffer.from(directory).toString("base64"), args: `-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ${request.input}`, verb: "RunAs" });
  const elevatedScript = Buffer.from(request.input, "base64").toString("utf16le");
  expect(elevatedScript).toContain(Buffer.from(executable).toString("base64"));
  expect(elevatedScript).toContain(Buffer.from(`"${worker}" ${pipe} ${token}`).toString("base64"));
  expect(elevatedScript).toContain("$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'");
});

test.skipIf(!windows)("one headless Electron worker handles PowerShell, ConPTY, and shutdown", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-terminal-test-"));
  try {
    const runner = path.join(root, "runner.cjs");
    await Promise.all([buildTerminalWorker(), build({
      entryPoints: [path.join(import.meta.dir, "fixtures", "terminal-host-check.ts")],
      bundle: true, platform: "node", outfile: runner,
    })]);
    const electronRoot = path.dirname(Bun.resolveSync("electron/package.json", import.meta.dir));
    const electron = path.join(electronRoot, "dist", (await Bun.file(path.join(electronRoot, "path.txt")).text()).trim());
    await promisify(execFile)(electron, [runner, terminalWorkerBundle], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: "1" }, windowsHide: true, timeout: 20_000,
    });
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 30_000);
