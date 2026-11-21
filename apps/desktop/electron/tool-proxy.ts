import { execFile } from "node:child_process";
import { windowsPowerShellPath } from "./system-path";

interface WindowsProxy {
  ProxyEnable?: number;
  ProxyServer?: string;
  ProxyOverride?: string;
  AutoConfigURL?: string;
  AutoDetect?: boolean;
}

export function manualToolProxy(settings: WindowsProxy): Record<string, string> | undefined {
  if (!settings.ProxyEnable || !settings.ProxyServer || settings.AutoConfigURL || settings.AutoDetect) return;
  const proxy = settings.ProxyServer.trim();
  const bypass = new Set(["localhost", "127.0.0.1", "[::1]"]);
  for (const pattern of settings.ProxyOverride?.split(/[;\s]+/).filter(Boolean) ?? []) {
    if (pattern === "127.*") continue; // Export the canonical loopback hosts, not a wildcard unsupported by NO_PROXY.
    if (!/^(?:\*\.)?(?:[\w.-]+|\[[\da-f:]+\])(?::\d+)?$/i.test(pattern)) return;
    bypass.add(pattern.replace(/^\*\./, "."));
  }
  const env: Record<string, string> = { NO_PROXY: [...bypass].join(",") };
  for (const entry of proxy.split(";")) {
    const match = /^(?:(http|https|socks)=)?((?:[\w.-]+|\[[\da-f:]+\])(?::\d+)?)$/i.exec(entry.trim());
    if (!match) return;
    const [, kind, host] = match;
    if (!kind) env.HTTP_PROXY = env.HTTPS_PROXY = `http://${host}`;
    else if (kind.toLowerCase() === "socks") env.ALL_PROXY = `socks5://${host}`;
    else env[`${kind.toUpperCase()}_PROXY`] = `http://${host}`;
  }
  return env;
}

/** PAC/WPAD stays in Chromium; only a static policy can be expressed as child-process environment variables. */
export function readToolSystemProxy(): Promise<Record<string, string> | undefined> {
  if (process.platform !== "win32") return Promise.resolve(undefined);
  const script = "[Console]::OutputEncoding=[Text.Encoding]::UTF8;"
    + "$k='HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings';"
    + "$s=Get-ItemProperty -LiteralPath $k -ErrorAction Stop;"
    + "$c=(Get-ItemProperty -LiteralPath ($k+'\\Connections') -ErrorAction SilentlyContinue).DefaultConnectionSettings;"
    + "[pscustomobject]@{ProxyEnable=$s.ProxyEnable;ProxyServer=$s.ProxyServer;ProxyOverride=$s.ProxyOverride;AutoConfigURL=$s.AutoConfigURL;AutoDetect=($c.Length -ge 12 -and ([BitConverter]::ToUInt32($c,8) -band 8) -ne 0)} | ConvertTo-Json -Compress";
  return new Promise(resolve => execFile(windowsPowerShellPath(), ["-NoProfile", "-NonInteractive", "-Command", script],
    { encoding: "utf8", windowsHide: true, timeout: 5_000 }, (error, output) => {
      if (error) return resolve(undefined);
      try { resolve(manualToolProxy(JSON.parse(output))); }
      catch { resolve(undefined); }
    }));
}
