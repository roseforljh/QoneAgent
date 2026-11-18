import { execFile } from "node:child_process";
import path from "node:path";

const READ_REGISTRY_PATH = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
  + "[Environment]::GetEnvironmentVariable('Path','Machine');[Environment]::GetEnvironmentVariable('Path','User')";

/** Machine then user entries, then entries only the launcher added; first occurrence wins. */
export function mergePathEntries(registry: string, inherited: string): string {
  const seen = new Set<string>();
  return [...registry.split(/[;\r\n]+/), ...inherited.split(";")]
    .map((entry) => entry.trim())
    .filter((entry) => {
      const key = entry.replace(/[\\/]+$/, "").toLowerCase();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .join(";");
}

export function windowsPowerShellPath(): string {
  return path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

/**
 * Explorer keeps the PATH it had at logon, so tools installed since then (bun,
 * cargo, …) are missing for apps started from the desktop. Re-read the current
 * PATH from the registry so the runtime, MCP servers and terminals can find them.
 */
export function refreshWindowsPath(): Promise<void> {
  if (process.platform !== "win32") return Promise.resolve();
  return new Promise((resolve) => {
    // Absolute path: the PATH being repaired may not even reach PowerShell.
    execFile(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", READ_REGISTRY_PATH],
      { encoding: "utf8", windowsHide: true, timeout: 5_000 }, (error, stdout) => {
        // Unreadable registry: keep the inherited PATH rather than block startup.
        if (!error && stdout.trim()) process.env.Path = mergePathEntries(stdout, process.env.Path ?? "");
        resolve();
      });
  });
}
