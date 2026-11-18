import { expect, test } from "bun:test";
import { execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { windowsPowerShellPath } from "../electron/system-path";
import { administratorLaunchEnabled, elevationArguments, setAdministratorLaunchEnabled, tryAdministratorLaunch, waitForElevationParent } from "../electron/windows-administrator";

test("administrator startup is opt-in, persists across reads, and falls back when UAC fails", async () => {
  const previous = process.env.QONE_DATA_DIR;
  const root = mkdtempSync(path.join(os.tmpdir(), "qone-administrator-"));
  process.env.QONE_DATA_DIR = root;
  try {
    let launches = 0;
    const launch = async () => { launches++; };
    expect(administratorLaunchEnabled()).toBe(false);
    expect(await tryAdministratorLaunch(launch)).toBe(false);
    expect(launches).toBe(0);
    setAdministratorLaunchEnabled(true);
    setAdministratorLaunchEnabled(true);
    expect(await tryAdministratorLaunch(launch)).toBe(true);
    expect(launches).toBe(1);
    expect(await tryAdministratorLaunch(async () => { throw new Error("UAC cancelled"); })).toBe(false);
    expect(administratorLaunchEnabled()).toBe(true);
    setAdministratorLaunchEnabled(false);
    expect(administratorLaunchEnabled()).toBe(false);
  } finally {
    if (previous === undefined) delete process.env.QONE_DATA_DIR;
    else process.env.QONE_DATA_DIR = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test.skipIf(process.platform !== "win32")("Windows PowerShell receives the literal executable and requests RunAs", () => {
  const directory = "C:\Users\33039\项目 ‘Windows’ test; (x) [1]";
  const executable = path.join(directory, "Qone Agent.exe");
  const args = elevationArguments(executable, 1234);
  const script = Buffer.from(args.at(-1)!, "base64").toString("utf16le");
  // Exercise PowerShell parsing without launching any executable or asking for UAC.
  const stub = `function Start-Process {
    param($FilePath, $WorkingDirectory, $ArgumentList, $Verb)
    [Console]::OutputEncoding = [Text.Encoding]::UTF8
    @{path=$FilePath; cwd=$WorkingDirectory; args=$ArgumentList; verb=$Verb} | ConvertTo-Json -Compress
  }; `;
  args[args.length - 1] = Buffer.from(stub + script, "utf16le").toString("base64");
  const launched = JSON.parse(execFileSync(windowsPowerShellPath(), args, { encoding: "utf8", timeout: 5_000 }));
  expect(launched).toEqual({ path: executable, cwd: directory, args: "--qone-elevation-parent=1234", verb: "RunAs" });
});

test("the replacement waits for the original process to release its resources", async () => {
  expect(await waitForElevationParent(process.pid)).toBe(false);
  const parent = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  const exited = once(parent, "exit");
  try {
    const pid = parent.pid!;
    expect(await waitForElevationParent(pid, 1)).toBe(false);
    const handoff = waitForElevationParent(pid, 1_000);
    parent.kill();
    await exited;
    expect(await handoff).toBe(true);
  } finally {
    parent.kill();
  }
});
