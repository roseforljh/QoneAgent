import * as pty from "node-pty";
import { readFileSync } from "node:fs";
import path from "node:path";
import { app, type BrowserWindow } from "electron";
import { killProcessTree } from "./process-tree";

interface TerminalSession {
  process: pty.IPty;
  terminalId: string;
}

export class TerminalManager {
  private sessions = new Map<string, TerminalSession>();
  private getMainWindow: () => BrowserWindow | null;

  constructor(getMainWindow: () => BrowserWindow | null, private spawnPty: typeof pty.spawn = pty.spawn) {
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

    const env = { ...process.env, TERM: "xterm-256color" } as Record<string, string>;
    if (["pwsh", "pwsh.exe"].includes(path.basename(shell).toLowerCase())) {
      // Prefer our source-patched module without changing the user's installation,
      // startup command, history, prediction or key bindings.
      const binaries = app.isPackaged ? path.join(process.resourcesPath, "binaries") : path.resolve(__dirname, "../binaries");
      const modules = path.join(binaries, "powershell");
      const recipe = readFileSync(path.join(modules, "active.txt"), "utf8").trim();
      env.PSModulePath = [path.join(modules, recipe), env.PSModulePath].filter(Boolean).join(path.delimiter);
    }
    // A pseudo console, never plain pipes: a shell on pipes runs
    // non-interactively, so it neither echoes input nor ends lines with CRLF.
    const child = this.spawnPty(shell, shellArgs, {
      name: "xterm-256color",
      cols,
      rows,
      // Bundled ConPTY synchronizes reflowed cursor positions and avoids the
      // inbox backend's console-list helper racing an already-dead shell.
      useConptyDll: true,
      cwd: cwd || process.cwd(),
      env,
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

    child.onData((data) => { if (owns()) emit("terminal:data", { terminalId, data }); });
    child.onExit(() => {
      if (!owns()) return;
      this.sessions.delete(terminalId);
      emit("terminal:exit", { terminalId });
    });
  }

  public write(terminalId: string, data: string): void {
    this.sessions.get(terminalId)?.process.write(data);
  }

  public resize(terminalId: string, cols: number, rows: number): void {
    const session = this.sessions.get(terminalId);
    if (!session || !(cols > 0) || !(rows > 0)) return;
    try {
      session.process.resize(cols, rows);
    } catch {
      // The shell exited between the renderer's fit and this resize.
    }
  }

  public clear(terminalId: string): void {
    this.sessions.get(terminalId)?.process.clear();
  }

  public kill(terminalId: string): Promise<void> {
    const session = this.sessions.get(terminalId);
    if (!session) return Promise.resolve();
    this.sessions.delete(terminalId);
    // A shell's children (builds, REPLs) outlive a plain kill on Windows.
    return killProcessTree(session.process);
  }

  public killAll(): void {
    for (const id of this.sessions.keys()) {
      this.kill(id);
    }
  }
}
