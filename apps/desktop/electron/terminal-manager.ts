import { spawn, type ChildProcess } from "node:child_process";
import type { BrowserWindow } from "electron";
import { killProcessTree } from "./process-tree";

interface TerminalSession {
  process: ChildProcess;
  terminalId: string;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private getMainWindow: () => BrowserWindow | null;

  constructor(getMainWindow: () => BrowserWindow | null, private spawnShell: typeof spawn = spawn) {
    this.getMainWindow = getMainWindow;
  }

  public spawn(
    terminalId: string,
    shell = "powershell.exe",
    cwd?: string,
    cols = 120,
    rows = 30,
    shellArgs: string[] = [],
  ): void {
    this.kill(terminalId);

    const child = this.spawnShell(shell, shellArgs, {
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

    const session: TerminalSession = { process: child, terminalId };
    this.sessions.set(terminalId, session);

    const emit = (channel: string, payload: unknown) => {
      const window = this.getMainWindow();
      if (window && !window.isDestroyed()) {
        window.webContents.send(channel, payload);
      }
    };
    // The same id can be reopened before the old process finishes dying. Only
    // the session that still owns this id may delete it or report its exit;
    // otherwise a late close would drop the new terminal and close its UI.
    const owns = () => this.sessions.get(terminalId) === session;
    const data = (payload: unknown) => { if (owns()) emit("terminal:data", payload); };

    child.stdout?.on("data", (chunk: Buffer) => {
      data({ terminalId, data: chunk.toString("utf8") });
    });

    child.stderr?.on("data", (chunk: Buffer) => {
      data({ terminalId, data: chunk.toString("utf8") });
    });

    child.on("close", () => {
      if (!owns()) return;
      this.sessions.delete(terminalId);
      emit("terminal:exit", { terminalId });
    });

    child.on("error", (error) => {
      if (!owns()) return;
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
      this.sessions.delete(terminalId);
      // A shell's children (builds, REPLs) outlive a plain kill on Windows.
      killProcessTree(session.process);
    }
  }

  public killAll(): void {
    for (const id of this.sessions.keys()) {
      this.kill(id);
    }
  }
}
