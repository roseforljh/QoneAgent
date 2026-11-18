import { execFile } from "node:child_process";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { getRuntimeDir } from "./data-paths";
import { windowsPowerShellPath } from "./system-path";
import { AdministratorTerminalHost } from "./administrator-terminal-host";

function preferenceFile(): string {
  // Keep existing users' opt-in without retaining the old whole-app behavior.
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

const encoded = (script: string) => Buffer.from(script, "utf16le").toString("base64");
const literal = (value: string) =>
  `[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${Buffer.from(value).toString("base64")}'))`;

export function elevationRequest(executable: string, worker: string, pipeId: string, token: string) {
  // Only this fixed, profile-free launcher is elevated; do not elevate Electron's UI.
  const workerScript = `
$ErrorActionPreference = 'Stop'
$identity = [Security.Principal.WindowsIdentity]::GetCurrent()
if (-not ([Security.Principal.WindowsPrincipal]::new($identity)).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { exit 1 }
$start = [Diagnostics.ProcessStartInfo]::new()
$start.FileName = (${literal(executable)})
$start.Arguments = (${literal(`"${worker}" ${pipeId} ${token}`)})
$start.WorkingDirectory = (${literal(path.dirname(executable))})
$start.UseShellExecute = $false
$start.CreateNoWindow = $true
foreach ($key in @($start.EnvironmentVariables.Keys)) {
  if ($key -match '^(NODE_|ELECTRON_|QONE_)') { $start.EnvironmentVariables.Remove($key) }
}
$start.EnvironmentVariables['ELECTRON_RUN_AS_NODE'] = '1'
$process = [Diagnostics.Process]::Start($start)
$process.Dispose()
`;
  // The middle-integrity launcher's command line must not contain the pipe secret.
  const script = "$ErrorActionPreference = 'Stop'; $worker = [Console]::In.ReadToEnd(); "
    + `Start-Process -FilePath (${literal(windowsPowerShellPath())}) -WorkingDirectory (${literal(path.dirname(executable))}) `
    + `-ArgumentList ('-NoProfile -NonInteractive -WindowStyle Hidden -EncodedCommand ' + $worker) -Verb RunAs`;
  return { args: ["-NoProfile", "-NonInteractive", "-EncodedCommand", encoded(script)], input: encoded(workerScript) };
}

function launchAdministratorTerminal(worker: string, pipe: string, token: string, signal: AbortSignal): Promise<void> {
  const { args, input } = elevationRequest(process.execPath, worker, pipe, token);
  return new Promise((resolve, reject) => {
    const launcher = execFile(windowsPowerShellPath(), args, { windowsHide: true, signal },
      error => { if (error) reject(error); else resolve(); });
    launcher.stdin?.on("error", reject);
    launcher.stdin?.end(input);
  });
}

export async function tryAdministratorTerminal(worker: string, signal: AbortSignal, launch = launchAdministratorTerminal): Promise<AdministratorTerminalHost | null> {
  if (signal.aborted || !administratorLaunchEnabled()) return null;
  try {
    if (!existsSync(worker)) throw new Error("Missing administrator terminal worker");
    return await AdministratorTerminalHost.start((pipe, token) => launch(worker, pipe, token, signal), signal);
  } catch (error) {
    // A declined prompt or a failed worker startup must not take the desktop down.
    if (!signal.aborted) console.warn("[startup] Administrator terminal not started:", error);
    return null;
  }
}
