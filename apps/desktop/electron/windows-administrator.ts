import { execFile } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { setTimeout } from "node:timers/promises";
import { promisify } from "node:util";
import { getRuntimeDir } from "./data-paths";
import { windowsPowerShellPath } from "./system-path";

export const elevationParentSwitch = "qone-elevation-parent";

function preferenceFile(): string {
  return path.join(getRuntimeDir(), "launch-as-administrator");
}

export function administratorLaunchEnabled(): boolean {
  return existsSync(preferenceFile());
}

export function setAdministratorLaunchEnabled(enabled: boolean): void {
  const file = preferenceFile();
  if (!enabled) {
    rmSync(file, { force: true });
    return;
  }
  try { writeFileSync(file, "", { flag: "wx" }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
}

export function elevationArguments(executable: string, parentPid: number): string[] {
  // Treat paths as data even if they contain PowerShell quotes or metacharacters.
  const decode = (value: string) => `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;
  const command = "$ErrorActionPreference = 'Stop'; "
    + `Start-Process -FilePath (${decode(executable)}) -WorkingDirectory (${decode(path.dirname(executable))}) `
    + `-ArgumentList '--${elevationParentSwitch}=${parentPid}' -Verb RunAs`;
  return ["-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(command, "utf16le").toString("base64")];
}

export async function tryAdministratorLaunch(
  launch: () => Promise<unknown> = () => promisify(execFile)(
    windowsPowerShellPath(), elevationArguments(process.execPath, process.pid), { windowsHide: true },
  ),
): Promise<boolean> {
  if (!administratorLaunchEnabled()) return false;
  try {
    await launch();
    return true;
  } catch (error) {
    // Cancelling the Windows prompt leaves the original instance running normally.
    console.warn("[startup] Administrator launch not completed:", error);
    return false;
  }
}

export async function waitForElevationParent(pid: number, timeoutMs = 10_000): Promise<boolean> {
  if (!Number.isInteger(pid) || pid <= 0 || pid > 0x7fffffff || pid === process.pid) return false;
  const deadline = Date.now() + timeoutMs;
  do {
    try { process.kill(pid, 0); }
    catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
    await setTimeout(50);
  } while (Date.now() < deadline);
  return false;
}
