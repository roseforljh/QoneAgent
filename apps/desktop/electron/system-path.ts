import { execFile } from "node:child_process";
import { lstatSync } from "node:fs";
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

export function windowsPowerShellPath(env: NodeJS.ProcessEnv = process.env): string {
  return path.win32.join(env.SystemRoot ?? "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

// Store 版应用执行别名（如 WindowsApps\pwsh.exe）是重解析点，stat/existsSync 会报 EACCES，必须用 lstatSync 检测。
function executableExists(candidate: string): boolean {
  try {
    return !lstatSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 解析 Windows 终端可执行文件的绝对路径，绕过 node-pty 查找 PATH 末尾缺分号项的缺陷；
 * 当 pwsh 不可用时自动降级到系统内置的 Windows PowerShell。
 */
export function resolveWindowsShell(
  shell: string,
  env: NodeJS.ProcessEnv = process.env,
  fileExists: (candidate: string) => boolean = executableExists,
): string {
  const trimmed = shell.trim();
  if (!trimmed) return windowsPowerShellPath(env);
  if (path.win32.isAbsolute(trimmed)) {
    if (fileExists(trimmed)) return trimmed;
    const base = path.win32.basename(trimmed).toLowerCase();
    if (base === "pwsh" || base === "pwsh.exe" || base === "powershell" || base === "powershell.exe") {
      return resolveWindowsShell(base, env, fileExists);
    }
    return trimmed;
  }

  const names = path.win32.extname(trimmed) ? [trimmed] : [`${trimmed}.exe`, trimmed];
  const pathValue = env.Path ?? env.PATH ?? "";
  for (const rawDir of pathValue.split(";")) {
    const dir = rawDir.trim().replace(/^"(.*)"$/, "$1");
    if (!dir) continue;
    for (const name of names) {
      const candidate = path.win32.join(dir, name);
      if (fileExists(candidate)) return candidate;
    }
  }

  const lower = trimmed.toLowerCase();
  if (lower === "pwsh" || lower === "pwsh.exe") {
    const fallbacks = [
      path.win32.join(env.ProgramFiles ?? "C:\\Program Files", "PowerShell", "7", "pwsh.exe"),
      env.LOCALAPPDATA ? path.win32.join(env.LOCALAPPDATA, "Microsoft", "WindowsApps", "pwsh.exe") : "",
    ].filter(Boolean);
    for (const candidate of fallbacks) {
      if (fileExists(candidate)) return candidate;
    }
    return windowsPowerShellPath(env);
  }
  if (lower === "powershell" || lower === "powershell.exe") {
    return windowsPowerShellPath(env);
  }
  return trimmed;
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
