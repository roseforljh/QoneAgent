import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import { app, Notification, type BrowserWindow } from "electron";
import { getRootDataDir } from "./data-paths";
import { getSecrets, persistRuntimeSecret } from "./secret-store";
import { killProcessTree } from "./process-tree";
import { elevatedTerminalEnv, type ShellHostRequest } from "@qone/protocol/terminal-host";
import type { AdministratorTerminalHost } from "./administrator-terminal-host";

export class SidecarManager {
  private child: ChildProcess | null = null;
  administratorHost: AdministratorTerminalHost | null = null;
  private exiting: Promise<void> = Promise.resolve();
  private generation = 0;
  private starting: Promise<void> | undefined;
  private readiness: Promise<void> = Promise.resolve();
  private batchQueue: unknown[] = [];
  private batchTimer: NodeJS.Timeout | null = null;
  private getMainWindow: () => BrowserWindow | null;
  private completedCopy = "Agent run completed";

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
  }

  public setCompletedCopy(copy: string) {
    this.completedCopy = copy;
  }

  /** The runtime bundle runs on this Electron binary in Node mode; dev mode keeps it rebuilt by esbuild watch. */
  private runtimeScript(): string {
    if (process.env.QONE_AGENT_RUNTIME) return path.resolve(process.env.QONE_AGENT_RUNTIME);
    return app.isPackaged
      ? path.join(process.resourcesPath, "binaries", "qone-runtime.mjs")
      : path.resolve(__dirname, "../binaries/qone-runtime.mjs");
  }

  public start(ready = this.readiness): Promise<void> {
    this.readiness = ready;
    this.stop();
    const generation = ++this.generation;
    // Gate sends while PATH is refreshed or the previous process tree exits.
    return this.starting = Promise.all([this.exiting, ready]).then(() => {
      if (generation === this.generation) this.spawnRuntime(generation);
    });
  }

  private spawnRuntime(currentGen: number): void {
    const script = this.runtimeScript();
    const host = this.administratorHost;
    const env = { ...process.env };
    delete env[elevatedTerminalEnv];
    if (host) env[elevatedTerminalEnv] = "1";

    const child = spawn(process.execPath, [script], {
      cwd: path.dirname(script),
      env: {
        ...env,
        ELECTRON_RUN_AS_NODE: "1",
        QONE_DATA_DIR: getRootDataDir(),
        // Bundled Node tools run on this Electron binary with ELECTRON_RUN_AS_NODE.
        QONE_NODE_EXECUTABLE: process.execPath,
      },
      stdio: host ? ["pipe", "pipe", "inherit", "ipc"] : ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });

    this.child = child;
    if (host) {
      // Runtime IPC is a separate channel, not the renderer-facing JSON protocol.
      child.on("message", (message: ShellHostRequest) => {
        if (this.generation !== currentGen || !message || typeof message.id !== "string") return;
        if (message.type !== "terminal-host.exec" && message.type !== "terminal-host.cancel") return;
        if (message.type === "terminal-host.exec" && (typeof message.command !== "string" || typeof message.cwd !== "string")) return;
        host.shell(child, message, response => {
          if (child.connected) child.send(response, () => {});
        });
      });
      child.once("disconnect", () => host.cancelShells(child));
    }
    // A failed write rejects its caller and also emits a separate stream error.
    child.stdin?.on("error", (error) => console.error("[sidecar] input pipe failed:", error));
    child.on("error", (error) => console.error("[sidecar] process error:", error));

    if (!child.stdout) {
      console.error("[sidecar] agent-runtime stdout not available");
      return;
    }

    const rl = readline.createInterface({ input: child.stdout, terminal: false });
    rl.on("error", (error) => console.error("[sidecar] output pipe failed:", error));

    rl.on("line", (line) => {
      if (this.generation !== currentGen || !line.trim()) return;
      void this.handleRuntimeLine(line, currentGen);
    });

    child.on("close", (code) => {
      // Lines still awaiting secret storage reach the renderer before the exit notice.
      void this.lines.then(() => {
        if (this.generation !== currentGen) return;
        this.flushBatch();
        this.emitToWindow([{ type: "runtime.exited", code }]);
      });
    });
  }

  // Secret storage is async; chaining keeps runtime events in their original order.
  private lines: Promise<void> = Promise.resolve();
  private handleRuntimeLine(rawLine: string, generation = this.generation): Promise<void> {
    this.lines = this.lines
      .then(() => { if (this.generation === generation) return this.processRuntimeLine(rawLine); })
      .catch(error => console.error("[sidecar] runtime line failed:", error));
    return this.lines;
  }

  private async processRuntimeLine(rawLine: string): Promise<void> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      this.enqueueBatch(rawLine);
      return;
    }

    // Batched payloads arrive as NDJSON arrays; intercept every event so no
    // credential-bearing event slips through to the renderer.
    const events = (await Promise.all((Array.isArray(parsed) ? parsed : [parsed])
      .map(async (event): Promise<unknown[]> => {
        if (event?.type === "mcp.credentials.request") {
          const { requestId, keys } = event;
          if (typeof requestId !== "string") return [];
          let values: Record<string, string> = {}, ok = false;
          try {
            if (!Array.isArray(keys) || keys.some(key => typeof key !== "string")) throw new Error();
            values = await getSecrets(keys);
            ok = true;
          } catch { /* A read failure is not a missing credential or an expired login. */ }
          void this.send(JSON.stringify({ type: "mcp.credentials.restored", requestId, values, ok })).catch(() => {});
          return [];
        }
        const persisted = await persistRuntimeSecret(event, (requestId, saved) => {
          void this.send(JSON.stringify({ type: "claude-code.credentials.saved", requestId, saved })).catch(() => {});
        });
        return Array.isArray(persisted) ? persisted : [persisted];
      }))).flat()
      .filter((event): event is object => event !== null);

    for (const event of events) {
      const record = event as { type?: unknown; event?: { type?: unknown } };
      if (record.type === "agent.event" && record.event?.type === "agent.completed") {
        try {
          new Notification({
            title: "QoneAgent",
            body: this.completedCopy,
          }).show();
        } catch (e) {
          console.error("[sidecar] notification failed:", e);
        }
      }
    }

    for (const event of events) this.enqueueBatch(event);
  }

  private enqueueBatch(item: unknown): void {
    this.batchQueue.push(item);
    if (this.batchQueue.length >= 16) {
      this.flushBatch();
    } else if (!this.batchTimer) {
      this.batchTimer = setTimeout(() => {
        this.flushBatch();
      }, 8);
    }
  }

  private flushBatch(): void {
    if (this.batchTimer) {
      clearTimeout(this.batchTimer);
      this.batchTimer = null;
    }
    if (this.batchQueue.length === 0) return;
    const batch = [...this.batchQueue];
    this.batchQueue = [];
    this.emitToWindow(batch);
  }

  private emitToWindow(payload: unknown): void {
    const window = this.getMainWindow();
    if (window && !window.isDestroyed()) {
      window.webContents.send("runtime-event", payload);
    }
  }

  public async send(cmd: string): Promise<void> {
    const generation = this.generation;
    await this.starting;
    return new Promise((resolve, reject) => {
      if (generation !== this.generation || !this.child || !this.child.stdin || this.child.stdin.destroyed) {
        return reject(new Error("agent runtime is not running"));
      }
      this.child.stdin.write(cmd + "\n", "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  public restart(): Promise<void> {
    return this.start();
  }

  public stop(): void {
    this.generation++;
    this.flushBatch();
    const child = this.child;
    this.child = null;
    if (!child) return;
    const closed = new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) { resolve(); return; }
      child.once("close", () => resolve());
    });
    // Join both the wrapper's pipes and the tree walker before opening the next DB.
    this.exiting = Promise.all([closed, killProcessTree(child)]).then(() => {});
  }
}
