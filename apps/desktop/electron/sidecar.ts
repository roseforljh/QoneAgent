import { spawn, type ChildProcess } from "node:child_process";
import readline from "node:readline";
import path from "node:path";
import fs from "node:fs";
import { Notification, type BrowserWindow } from "electron";
import { getRootDataDir } from "./data-paths";
import { persistRuntimeSecret } from "./secret-store";

export class SidecarManager {
  private child: ChildProcess | null = null;
  private generation = 0;
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

  private resolveRuntimeEntry(): { command: string; args: string[]; cwd: string } {
    if (process.env.QONE_AGENT_RUNTIME) {
      const explicit = path.resolve(process.env.QONE_AGENT_RUNTIME);
      if (explicit.endsWith(".exe")) {
        return { command: explicit, args: [], cwd: path.dirname(explicit) };
      }
      return { command: "bun", args: ["run", explicit], cwd: path.dirname(path.dirname(explicit)) };
    }

    // 优先检查打包资源目录
    const packagedCandidate = typeof process.resourcesPath === "string"
      ? path.join(process.resourcesPath, "binaries", "qone-runtime.exe")
      : null;
    if (packagedCandidate && fs.existsSync(packagedCandidate)) {
      return { command: packagedCandidate, args: [], cwd: path.dirname(packagedCandidate) };
    }

    const localBinaryCandidate = path.resolve(__dirname, "../binaries/qone-runtime.exe");
    if (fs.existsSync(localBinaryCandidate)) {
      return { command: localBinaryCandidate, args: [], cwd: path.dirname(localBinaryCandidate) };
    }

    // 默认查找 apps/agent-runtime/src/index.ts
    const devPath = path.resolve(__dirname, "../../agent-runtime/src/index.ts");
    if (fs.existsSync(devPath)) {
      return { command: "bun", args: ["run", devPath], cwd: path.resolve(__dirname, "../../agent-runtime") };
    }

    return { command: "bun", args: ["run", devPath], cwd: path.dirname(devPath) };
  }

  public start(): void {
    this.stop();
    const currentGen = ++this.generation;
    const { command, args, cwd } = this.resolveRuntimeEntry();

    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        QONE_DATA_DIR: getRootDataDir(),
      },
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });

    this.child = child;

    if (!child.stdout) {
      console.error("[sidecar] agent-runtime stdout not available");
      return;
    }

    const rl = readline.createInterface({ input: child.stdout, terminal: false });

    rl.on("line", (line) => {
      if (this.generation !== currentGen || !line.trim()) return;
      this.handleRuntimeLine(line);
    });

    child.on("close", (code) => {
      if (this.generation === currentGen) {
        this.flushBatch();
        this.emitToWindow([{ type: "runtime.exited", code }]);
      }
    });

    child.on("error", (error) => {
      console.error("[sidecar] process error:", error);
    });
  }

  private handleRuntimeLine(rawLine: string): void {
    let parsed: unknown;
    try {
      parsed = JSON.parse(rawLine);
    } catch {
      this.enqueueBatch(rawLine);
      return;
    }

    // Batched payloads arrive as NDJSON arrays; intercept every event so no
    // credential-bearing event slips through to the renderer.
    const events = (Array.isArray(parsed) ? parsed : [parsed])
      .map((event) => persistRuntimeSecret(event))
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

  public send(cmd: string): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.child || !this.child.stdin || this.child.stdin.destroyed) {
        return reject(new Error("agent runtime is not running"));
      }
      this.child.stdin.write(cmd + "\n", "utf8", (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  public restart(): Promise<void> {
    this.start();
    return Promise.resolve();
  }

  public stop(): void {
    this.flushBatch();
    if (this.child) {
      try {
        this.child.kill();
      } catch {
        // 忽略
      }
      this.child = null;
    }
  }
}
