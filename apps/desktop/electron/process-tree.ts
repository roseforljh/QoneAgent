import { spawn } from "node:child_process";
import path from "node:path";

/**
 * Kill a child and everything it spawned.
 *
 * Windows needs `taskkill /T`: a plain `kill()` leaves grandchildren running
 * (a shell's REPLs/builds, the real runtime behind a `bun run` wrapper), and
 * killing the parent first orphans them before the tree walk can reach them.
 * So the tree walk runs first and the plain kill only follows it.
 */
export function killProcessTree(child: { readonly pid?: number; kill(): unknown }): Promise<void> {
  const kill = () => { try { child.kill(); } catch { /* already gone */ } };
  const pid = child.pid;
  if (process.platform === "win32" && pid !== undefined) {
    return new Promise<void>((resolve) => {
      const done = () => { kill(); resolve(); };
      try {
        const killer = spawn(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe"),
          ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
        killer.once("error", done);
        killer.once("close", done);
      } catch { done(); }
    });
  }
  kill();
  return Promise.resolve();
}
