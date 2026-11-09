import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserWindow } from "electron";

interface TerminalSession {
  process: ChildProcess;
  terminalId: string;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private getMainWindow: () => BrowserWindow | null;

  constructor(getMainWindow: () => BrowserWindow | null) {
    this.getMainWindow = getMainWindow;
  }

  public spawn(
    terminalId: string,
    shell = "powershell.exe",
    cwd?: string,
    cols = 120,
    rows = 30
  ): void {
    this.kill(terminalId);

    const child = spawn(shell, [], {
      cwd: cwd || process.cwd(),
      env: {
        ...process.env,
        TERM: "xterm-256color",
        COLUMNS: String(cols),
        LINES: String(rows),
      },
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    this.sessions.set(terminalId, { process: child, terminalId });

    const emit = (channel: string, payload: unknown) => {
      const window = this.getMainWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    };

    child.stdout?.on("data", (chunk: Buffer) => {
      emit("terminal:data", { terminalId, data: chunk.toString("utf8") });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      emit("terminal:data", { terminalId, data: chunk.toString("utf8") });
    });

    child.on("close", () => {
      this.sessions.delete(terminalId);
      emit("terminal:exit", { terminalId });
    });

    child.on("error", (error) => {
      emit("terminal:data", { terminalId, data: `\r\n[terminal error: ${error.message}]\r\n` });
      this.sessions.delete(terminalId);
      emit("terminal:exit", { terminalId });
    });
  }

  public write(terminalId: string, data: string): void {
    const session = this.sessions.get(terminalId);
    if (session && session.process.stdin && !session.process.stdin.destroyed) {
      session.process.stdin.write(data, "utf8");
    }
  }

  public resize(_terminalId: string, _cols: number, _rows: number): void {
    // 纯 Node pipe 进程下无法原生发送 SIGWINCH，但保持 API 兼容
  }

  public kill(terminalId: string): void {
    const session = this.sessions.get(terminalId);
    if (session) {
      try {
        session.process.kill();
      } catch {
        // 忽略
      }
      this.sessions.delete(terminalId);
    }
  }

  public killAll(): void {
    for (const id of this.sessions.keys()) {
      this.kill(id);
    }
  }
}
