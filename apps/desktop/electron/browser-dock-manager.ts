import { WebContentsView, shell, type BrowserWindow } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeDir } from "./data-paths";

interface BrowserSession {
  id: string;
  view: WebContentsView;
  url: string;
}

export class BrowserDockManager {
  private sessions = new Map<string, BrowserSession>();
  /** Preview files this manager wrote; app exit removes exactly these. */
  private previewFiles = new Set<string>();
  private getMainWindow: () => BrowserWindow | null;
  private cdpPort: (() => Promise<number>) | null;

  constructor(getMainWindow: () => BrowserWindow | null, cdpPort: (() => Promise<number>) | null) {
    this.getMainWindow = getMainWindow;
    this.cdpPort = cdpPort;
  }

  public open(
    browserId: string,
    url: string,
    x: number,
    y: number,
    w: number,
    h: number,
    initializationScript?: string
  ): void {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    this.close(browserId);

    const view = new WebContentsView({
      webPreferences: {
        // Untrusted pages must not share the privileged main window’s app/asset protocols.
        partition: this.cdpPort ? undefined : "persist:qone-administrator-browser",
        sandbox: true,
        contextIsolation: true,
      },
    });

    const session: BrowserSession = { id: browserId, view, url };
    this.sessions.set(browserId, session);

    mainWindow.contentView.addChildView(view);
    view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(0, Math.round(w)),
      height: Math.max(0, Math.round(h)),
    });

    if (initializationScript) {
      view.webContents.on("dom-ready", () => {
        view.webContents.executeJavaScript(initializationScript).catch(() => {});
      });
    }

    view.webContents.on("did-navigate", (_event, navigatedUrl) => {
      session.url = navigatedUrl;
      mainWindow.webContents.send("browser:navigated", { browserId, url: navigatedUrl });
    });

    view.webContents.on("did-finish-load", () => {
      mainWindow.webContents.send("browser:loaded", { browserId });
    });

    if (url) {
      view.webContents.loadURL(url).catch(() => {});
    }
  }

  public navigate(browserId: string, url: string): void {
    const session = this.sessions.get(browserId);
    if (session) {
      session.url = url;
      session.view.webContents.loadURL(url).catch(() => {});
    }
  }

  public preview(browserId: string, html: string): void {
    const session = this.sessions.get(browserId);
    if (session) {
      const dataUri = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`;
      session.view.webContents.loadURL(dataUri).catch(() => {});
    }
  }

  public openPreviewExternal(html: string): void {
    // Keep previews under Qone's own runtime dir so closeAll can remove them;
    // the OS temp dir would accumulate one file per preview forever.
    const directory = path.join(getRuntimeDir(), "previews");
    fs.mkdirSync(directory, { recursive: true });
    const tmpFile = path.join(directory, `preview-${crypto.randomUUID()}.html`);
    fs.writeFileSync(tmpFile, html, "utf8");
    this.previewFiles.add(tmpFile);
    shell.openPath(tmpFile).catch(() => {});
  }

  public bounds(browserId: string, x: number, y: number, w: number, h: number): void {
    const session = this.sessions.get(browserId);
    if (session) {
      session.view.setBounds({
        x: Math.round(x),
        y: Math.round(y),
        width: Math.max(0, Math.round(w)),
        height: Math.max(0, Math.round(h)),
      });
    }
  }

  public setVisible(browserId: string, visible: boolean): void {
    const session = this.sessions.get(browserId);
    if (session) {
      session.view.setVisible(visible);
    }
  }

  public async eval(browserId: string, script: string): Promise<void> {
    const session = this.sessions.get(browserId);
    if (session) {
      await session.view.webContents.executeJavaScript(script);
    }
  }

  public async evalResult(browserId: string, script: string): Promise<string> {
    const session = this.sessions.get(browserId);
    if (!session) throw new Error("browser session not found");
    const result = await session.view.webContents.executeJavaScript(script);
    return typeof result === "string" ? result : JSON.stringify(result);
  }

  public close(browserId: string): void {
    const session = this.sessions.get(browserId);
    if (session) {
      const mainWindow = this.getMainWindow();
      if (mainWindow && !mainWindow.isDestroyed()) {
        try {
          mainWindow.contentView.removeChildView(session.view);
        } catch {
          // 忽略
        }
      }
      this.sessions.delete(browserId);
      // removeChildView only detaches the view; its renderer process and
      // webContents survive until destroyed, leaking one per dock open/close.
      // No beforeunload: a page must not be able to veto the teardown.
      if (!session.view.webContents.isDestroyed()) session.view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  public async getCdpEndpoint(browserId: string): Promise<string> {
    if (!this.cdpPort) throw new Error("Browser remote debugging is disabled in administrator mode");
    const session = this.sessions.get(browserId);
    if (!session) throw new Error("browser session not found");

    const port = await this.cdpPort();
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json() as Array<{ id: string; url: string; webSocketDebuggerUrl?: string }>;
      const target = list.find((item) => item.url === session.url) || list[0];
      if (target && target.webSocketDebuggerUrl) {
        return target.webSocketDebuggerUrl;
      }
      if (target && target.id) {
        return `ws://127.0.0.1:${port}/devtools/page/${target.id}`;
      }
    } catch {
      // 容错
    }
    return `ws://127.0.0.1:${port}/devtools/browser`;
  }

  public closeAll(): void {
    for (const id of this.sessions.keys()) {
      this.close(id);
    }
    for (const file of this.previewFiles) {
      try { fs.rmSync(file, { force: true }); } catch { /* already gone */ }
    }
    this.previewFiles.clear();
  }
}
