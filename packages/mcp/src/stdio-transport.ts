import { spawn } from "node:child_process";
import path from "node:path";
import { StdioClientTransport, type StdioServerParameters } from "@modelcontextprotocol/client/stdio";

/**
 * The SDK's `close()` signals only the direct child. On Windows a stdio MCP
 * server is typically reached through `npx.cmd` → `node` → real server, so
 * killing the shim leaves the actual server and anything it spawned running.
 * `taskkill /T` walks the whole tree before the SDK's own teardown runs.
 *
 * ponytail: POSIX has no equivalent walk here; the SDK's plain SIGTERM stays
 * in place and a detached process group would need SDK changes. Add only if a
 * POSIX server is observed leaking children.
 */
export class TreeKillingStdioTransport extends StdioClientTransport {
  constructor(server: StdioServerParameters) {
    super(server);
  }

  async close(): Promise<void> {
    const pid = this.pid;
    if (pid && process.platform === "win32") {
      await killWindowsTree(pid);
    }
    await super.close();
  }
}

function killWindowsTree(pid: number): Promise<void> {
  return new Promise((resolve) => {
    const taskkill = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    let killer;
    try {
      killer = spawn(taskkill, ["/F", "/T", "/PID", String(pid)], { stdio: "ignore", windowsHide: true });
    } catch {
      return resolve();
    }
    // A failed taskkill must never block the transport teardown.
    killer.once("error", () => resolve());
    killer.once("close", () => resolve());
  });
}