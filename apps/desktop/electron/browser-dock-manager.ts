import type { AppWindow } from "./app-window";
import { WebContentsView, shell, type Session, type WebContents } from "electron";
import fs from "node:fs";
import path from "node:path";
import { getRuntimeDir } from "./data-paths";
import type { DockCdp } from "./dock-cdp";
import { installContextMenu } from "./native-menus";

const EVAL_RESULT_TIMEOUT_MS = 10_000;

interface BrowserSession {
  id: string;
  view: WebContentsView;
  url: string;
  hidden?: boolean;
  /** 页面发起过通行密钥登录，等 AI 下一次操作时取走并告诉它需要用户登录。 */
  passkeyRequested?: boolean;
  /** 当前页面不出现横向滚动所需的 CSS 宽度；与缩放无关，换页后重测。 */
  minWidth?: number;
  measuring?: boolean;
  remeasure?: boolean;
  /** 每次布局调用递增；等待截图的旧调用据此认出自已过时。 */
  layoutSeq: number;
}

// 返回页面横向溢出时的内容宽度（CSS px），未溢出或页面本身裁掉横向溢出时返回 0。
const MEASURE_OVERFLOW = `(() => {
  const root = document.documentElement;
  if (!root) return 0;
  const rootX = getComputedStyle(root).overflowX;
  const viewportX = rootX === "visible" && document.body ? getComputedStyle(document.body).overflowX : rootX;
  if (viewportX === "hidden" || viewportX === "clip") return 0;
  const width = (document.scrollingElement || root).scrollWidth;
  return width > root.clientWidth + 1 ? width : 0;
})()`;

function isOnScreen({ x, y, width, height }: { x: number; y: number; width: number; height: number }): boolean {
  return width > 0 && height > 0 && x + width > 0 && y + height > 0;
}

export class BrowserDockManager {
  private sessions = new Map<string, BrowserSession>();
  /** Preview files this manager wrote; app exit removes exactly these. */
  private previewFiles = new Set<string>();
  private getMainWindow: () => AppWindow | null;
  private cdpPort: (() => Promise<number>) | null;
  private guardedSessions = new WeakSet<Session>();
  /** 弹窗打开期间内置浏览器位于主界面之下。 */
  private underlay = false;

  constructor(getMainWindow: () => AppWindow | null, cdpPort: (() => Promise<number>) | null, private readonly dockCdp?: DockCdp) {
    this.getMainWindow = getMainWindow;
    this.cdpPort = cdpPort;
  }

  public async open(
    browserId: string,
    url: string,
    x: number,
    y: number,
    w: number,
    h: number,
    initializationScript?: string
  ): Promise<void> {
    const mainWindow = this.getMainWindow();
    if (!mainWindow) return;

    this.close(browserId);

    const view = new WebContentsView({
      webPreferences: {
        // Preserve the normal browser profile when only the terminal is elevated.
        // A manually elevated desktop keeps untrusted pages in a separate session.
        partition: this.cdpPort || this.dockCdp ? undefined : "persist:qone-administrator-browser",
        sandbox: true,
        contextIsolation: true,
        // 缩放只作用于本视图；默认按域名共享，会连带缩放同域的主界面（开发态 localhost）。
        zoomMode: "isolated",
        enablePreferredSizeMode: true,
        preload: path.join(__dirname, "dock-preload.cjs"),
      },
    });
    this.guardExternalProtocols(view.webContents.session);

    const session: BrowserSession = { id: browserId, view, url, layoutSeq: 0 };
    this.sessions.set(browserId, session);

    this.place(mainWindow, view);
    view.setBounds({
      x: Math.round(x),
      y: Math.round(y),
      width: Math.max(0, Math.round(w)),
      height: Math.max(0, Math.round(h)),
    });
    this.syncAudio(session);

    view.webContents.on("did-navigate", (_event, navigatedUrl) => {
      session.url = navigatedUrl;
      session.minWidth = undefined;
      this.applyZoom(session);
      mainWindow.webContents.send("browser:navigated", { browserId, url: navigatedUrl });
    });

    // 单页应用路由切换只触发 did-navigate-in-page，同步回传给地址栏实时更新。
    view.webContents.on("did-navigate-in-page", (_event, navigatedUrl, isMainFrame) => {
      if (!isMainFrame) return;
      session.url = navigatedUrl;
      mainWindow.webContents.send("browser:navigated", { browserId, url: navigatedUrl });
      void this.fitWidth(session);
    });

    // 内容尺寸变化（异步渲染、单页应用切换）后重新检查页面是否被截断。
    view.webContents.on("preferred-size-changed", () => void this.fitWidth(session));

    // 拦截页面内新窗口打开，改为在当前内置浏览器内跳转，避免弹出独立窗口脱离右侧面板。
    // 例外：用户浏览器里带窗口特性的 window.open 是第三方登录弹窗，登录结果经 window.opener 回传，必须真开窗口。
    view.webContents.setWindowOpenHandler?.(({ url: nextUrl, disposition }) => {
      if (!/^https?:\/\//i.test(nextUrl)) return { action: "deny" };
      if (browserId.startsWith("auth-page-") && disposition === "new-window") {
        return { action: "allow", overrideBrowserWindowOptions: { parent: mainWindow, autoHideMenuBar: true } };
      }
      session.url = nextUrl;
      view.webContents.loadURL(nextUrl).catch(() => {});
      return { action: "deny" };
    });
    installContextMenu(view.webContents);
    view.webContents.on("ipc-message", (_event, channel) => {
      if (channel === "dock:passkey-request") session.passkeyRequested = true;
    });

    view.webContents.on("did-finish-load", () => {
      mainWindow.webContents.send("browser:loaded", { browserId });
      void this.fitWidth(session);
    });

    if (initializationScript) {
      // 须在页面脚本之前注入（等同 WebView2 AddScriptToExecuteOnDocumentCreated），
      // 否则页面首个接口请求已发出、拦截不到；dom-ready 时页面脚本早已执行。
      view.webContents.debugger.attach("1.3");
      await view.webContents.debugger.sendCommand("Page.enable");
      await view.webContents.debugger.sendCommand("Page.addScriptToEvaluateOnNewDocument", { source: initializationScript });
      if (this.sessions.get(browserId) !== session) return;
    }

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
      // Base64 keeps CJK pages ~3x smaller than percent-encoding under Chromium's 2 MB URL limit.
      const dataUri = `data:text/html;charset=utf-8;base64,${Buffer.from(html, "utf8").toString("base64")}`;
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

  /** Returns a snapshot of the page when this call parks an on-screen view off-screen. */
  public async bounds(browserId: string, x: number, y: number, w: number, h: number): Promise<string | undefined> {
    const session = this.sessions.get(browserId);
    if (session) {
      const next = { x: Math.round(x), y: Math.round(y), width: Math.max(0, Math.round(w)), height: Math.max(0, Math.round(h)) };
      const seq = ++session.layoutSeq;
      const snapshot = isOnScreen(next) ? undefined : await this.snapshot(session);
      // 截图期间收到更新的布局调用时，本次已过时，不能再把视图移走。
      if (this.sessions.get(browserId) !== session || seq !== session.layoutSeq) return undefined;
      session.view.setBounds(next);
      this.syncAudio(session);
      this.applyZoom(session);
      void this.fitWidth(session);
      return snapshot;
    }
    return undefined;
  }

  /**
   * 原生视图压在 DOM 之上，弹窗出现时只能隐藏；隐藏前截一张图交给渲染层垫在原位，
   * 弹窗背后仍是网页画面而不是空白面板。
   */
  private async snapshot(session: BrowserSession): Promise<string | undefined> {
    const contents = session.view.webContents;
    if (contents.isDestroyed() || session.hidden || !isOnScreen(session.view.getBounds())) return undefined;
    try {
      const image = await contents.capturePage();
      return image.isEmpty() ? undefined : `data:image/jpeg;base64,${image.toJPEG(85).toString("base64")}`;
    } catch {
      return undefined;
    }
  }

  /**
   * 隐藏或停在屏幕外的页面仍在播放（切换会话后保留的 AI 浏览器、后台抖音解析页），
   * 用户找不到画面却听得到声音。看不见就静音，重新显示时恢复。
   */
  private syncAudio(session: BrowserSession): void {
    const contents = session.view.webContents;
    if (contents.isDestroyed()) return;
    contents.setAudioMuted(Boolean(session.hidden) || !isOnScreen(session.view.getBounds()));
  }

  /**
   * 桌面站点常带固定最小宽度（如抖音），面板比它窄时右侧被截断。
   * 按页面实际需要的宽度等比缩小整页，能自适应的页面保持 100%。
   */
  private async fitWidth(session: BrowserSession): Promise<void> {
    if (session.measuring) {
      session.remeasure = true;
      return;
    }
    session.measuring = true;
    try {
      do {
        session.remeasure = false;
        const contents = session.view.webContents;
        if (contents.isDestroyed()) return;
        const overflow = await contents.executeJavaScript(MEASURE_OVERFLOW).catch(() => 0);
        if (this.sessions.get(session.id) !== session) return;
        if (typeof overflow === "number" && overflow > (session.minWidth ?? 0)) session.minWidth = overflow;
        this.applyZoom(session);
      } while (session.remeasure);
    } finally {
      session.measuring = false;
    }
  }

  private applyZoom(session: BrowserSession): void {
    const contents = session.view.webContents;
    const width = session.view.getBounds().width;
    if (contents.isDestroyed() || width <= 0) return;
    // minWidth 以 CSS 像素计，缩放后视口宽度 = 视图宽度 / 缩放倍数。
    const zoom = session.minWidth ? Math.min(1, width / session.minWidth) : 1;
    if (Math.abs(contents.getZoomFactor() - zoom) > 0.005) contents.setZoomFactor(zoom);
  }

  /** 网页唤起 bytedance:// 等外部协议时，Electron 默认交给系统，Windows 会弹「需要新应用」窗口。 */
  private guardExternalProtocols(session: Session): void {
    if (this.guardedSessions.has(session)) return;
    this.guardedSessions.add(session);
    // 内置浏览器一律拒绝；同一会话里的主窗口等页面保持 Electron 默认的放行。
    session.setPermissionRequestHandler((requester, permission, callback) => {
      callback(!(permission === "openExternal" && this.isDockContents(requester)));
    });
  }

  private isDockContents(contents: WebContents): boolean {
    for (const session of this.sessions.values()) {
      if (session.view.webContents === contents) return true;
    }
    return false;
  }

  /** Returns a snapshot of the page when this call hides a shown view. */
  /**
   * 弹窗打开时把内置浏览器沉到主界面之下并让主界面透明：渲染层在网页区域挖出透明洞，
   * 弹窗与半透明遮罩盖在实时网页上；关闭后网页回到顶层、主界面恢复不透明。
   */
  public setUnderlay(on: boolean): void {
    if (this.underlay === on) return;
    this.underlay = on;
    const mainWindow = this.getMainWindow();
    if (!mainWindow || mainWindow.isDestroyed()) return;
    if (on) mainWindow.setHubTransparent(true);
    for (const session of this.sessions.values()) this.place(mainWindow, session.view);
    if (!on) mainWindow.setHubTransparent(false);
  }

  private place(mainWindow: AppWindow, view: WebContentsView): void {
    const root = mainWindow.contentView;
    if (!this.underlay) {
      // 已在子视图里时 addChildView 会把它移到最顶层。
      root.addChildView(view);
      return;
    }
    root.addChildView(view, 0);
    // 文档只保证已有子视图会被移到顶层，索引被忽略时先摘下再插入。
    if (root.children.indexOf(view) !== 0) {
      root.removeChildView(view);
      root.addChildView(view, 0);
    }
  }

  public async setVisible(browserId: string, visible: boolean): Promise<string | undefined> {
    const session = this.sessions.get(browserId);
    if (!session) return undefined;
    const seq = ++session.layoutSeq;
    const snapshot = visible ? undefined : await this.snapshot(session);
    if (this.sessions.get(browserId) !== session || seq !== session.layoutSeq) return undefined;
    session.view.setVisible(visible);
    session.hidden = !visible;
    this.syncAudio(session);
    return snapshot;
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
    // 调用方沿用 WebView2 ExecuteScript 约定：返回值恰好 JSON 编码一次。脚本返回的 JSON 字符串
    // 若原样透传，调用方解析一次得到对象而非字符串，结果被当成无效、一直等到超时。
    // executeJavaScript waits for the page to stop loading and never times out; WebView2 answered within 10 s.
    // Not ready by then reads as null ("not yet"), which the polling callers already retry until their own deadline.
    let timer: ReturnType<typeof setTimeout> | undefined;
    const notReady = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), EVAL_RESULT_TIMEOUT_MS); });
    try {
      return JSON.stringify(await Promise.race([session.view.webContents.executeJavaScript(script), notReady]) ?? null);
    } finally {
      clearTimeout(timer);
    }
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
      this.dockCdp?.close(session.view.webContents);
      // removeChildView only detaches the view; its renderer process and
      // webContents survive until destroyed, leaking one per dock open/close.
      // No beforeunload: a page must not be able to veto the teardown.
      if (!session.view.webContents.isDestroyed()) session.view.webContents.close({ waitForBeforeUnload: false });
    }
  }

  /** 读取并清除「页面要求通行密钥登录」标记。 */
  public takePasskeyRequest(browserId: string): boolean {
    const session = this.sessions.get(browserId);
    const requested = Boolean(session?.passkeyRequested);
    if (session) session.passkeyRequested = false;
    return requested;
  }

  public async getCdpEndpoint(browserId: string): Promise<string> {
    if (!this.cdpPort && !this.dockCdp) throw new Error("Browser remote debugging is disabled in administrator mode");
    const session = this.sessions.get(browserId);
    if (!session) throw new Error("browser session not found");
    if (this.dockCdp) return this.dockCdp.endpoint(session.view.webContents);
    if (!this.cdpPort) throw new Error("Browser remote debugging port is unavailable");

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
    this.dockCdp?.stop();
  }
}
