import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  protocol,
  net,
  screen,
  shell,
  type Rectangle,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import { pathToFileURL } from "node:url";
import { ensureGlobalInstructions, getRuntimeDir } from "./data-paths";
import { SidecarManager } from "./sidecar";
import { TerminalManager } from "./terminal-manager";
import { BrowserDockManager } from "./browser-dock-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { DesktopUpdater } from "./updater";
import { installDevtoolsShortcutGuard } from "./devtools-policy";
import { localRangeResponse } from "./local-file-range";
import { refreshWindowsPath } from "./system-path";
import { administratorLaunchEnabled, tryAdministratorTerminal } from "./windows-administrator";
import { DockCdp } from "./dock-cdp";
import { installApplicationMenu, installContextMenu, nativeCopy } from "./native-menus";
import { isAuthorizedAsset } from "./file-dialogs";

const windows = process.platform === "win32";
const integrity = windows ? app.getAppMetrics().find(({ pid }) => pid === process.pid)?.integrityLevel : undefined;
const elevated = integrity === "high";
// With administrative privileges, a loopback CDP client could control the privileged desktop bridge.
const restricted = windows && (elevated || !integrity || integrity === "unknown");
// The development renderer loads over HTTP; it never gets an elevated command channel.
const administratorSupported = windows && app.isPackaged && integrity === "medium";
const administratorRequested = administratorSupported && administratorLaunchEnabled();
const administratorLifetime = new AbortController();
// Windows only shows toasts for the AUMID on the installer's Start Menu shortcut (electron-builder appId).
if (windows) app.setAppUserModelId("com.qone.agent");

// 注册 app 与 asset 特权协议
protocol.registerSchemesAsPrivileged([
  {
    scheme: "app",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
    },
  },
  {
    scheme: "asset",
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      bypassCSP: true,
      stream: true,
    },
  },
]);

// 网页调用通行密钥（WebAuthn）时 Chromium 走 Windows 原生接口，弹出「Windows 安全中心 · 选择通行密钥」系统窗口，
// AI 操作内置浏览器时会被它挡住。关掉原生接口后请求静默挂起、不再弹窗，需要登录由用户在右侧栏用账号密码等方式完成。
app.commandLine.appendSwitch("disable-features", "WebAuthenticationUseNativeWinApi");

// CDP 端口：0 让 Chromium 自己绑定空闲端口，并把实际端口写入 DevToolsActivePort。
// 预先探测端口不可行：Node 的 listen 是异步的，探测结果总是落回固定端口，被占用时 DevTools 直接起不来。
const devtoolsPortFile = path.join(app.getPath("userData"), "DevToolsActivePort");
const configuredDevtoolsPort = process.env.QONE_WEBVIEW_CDP_PORT?.trim() || "0";
if (restricted || administratorRequested) {
  app.commandLine.removeSwitch("remote-debugging-port");
  app.commandLine.removeSwitch("remote-debugging-pipe");
  app.commandLine.removeSwitch("remote-allow-origins");
} else {
  app.commandLine.appendSwitch("remote-debugging-port", configuredDevtoolsPort);
  app.commandLine.appendSwitch("remote-allow-origins", "*");
}

async function devtoolsPort(): Promise<number> {
  if (configuredDevtoolsPort !== "0") return Number(configuredDevtoolsPort);
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      const port = parseInt(await fs.promises.readFile(devtoolsPortFile, "utf8"), 10);
      if (port > 0) return port;
    } catch { /* Chromium writes the file shortly after startup. */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("DevTools port is unavailable");
}

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const sidecar = new SidecarManager(() => mainWindow);
const terminal = new TerminalManager(() => mainWindow);
const browserDock = new BrowserDockManager(() => mainWindow, restricted || administratorRequested ? null : devtoolsPort,
  administratorRequested ? new DockCdp() : undefined);
const updater = new DesktopUpdater(undefined, (input, init) => net.fetch(input, init));

// 窗口状态管理
const windowStateFile = path.join(getRuntimeDir(), "window-state.json");
interface SavedWindowState {
  x: number;
  y: number;
  width: number;
  height: number;
  maximized: boolean;
}

function loadWindowState(): Partial<SavedWindowState> {
  try {
    if (fs.existsSync(windowStateFile)) {
      return JSON.parse(fs.readFileSync(windowStateFile, "utf8"));
    }
  } catch {
    // 忽略
  }
  return {};
}

function saveWindowState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    const isMaximized = mainWindow.isMaximized();
    let bounds: Rectangle;
    if (isMaximized) {
      // 记录普通尺寸
      const prev = loadWindowState();
      bounds = {
        x: prev.x ?? 100,
        y: prev.y ?? 100,
        width: prev.width ?? 1200,
        height: prev.height ?? 800,
      };
    } else {
      bounds = mainWindow.getBounds();
    }
    const state: SavedWindowState = {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
      maximized: isMaximized,
    };
    fs.writeFileSync(windowStateFile, JSON.stringify(state), "utf8");
  } catch {
    // 忽略
  }
}

function openExternalLink(url: string): void {
  if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url);
}

function createMainWindow(): BrowserWindow {
  const savedState = loadWindowState();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const width = Math.min(savedState.width || 1280, Math.round(screenWidth * 0.9));
  const height = Math.min(savedState.height || 860, Math.round(screenHeight * 0.9));
  // Reopen where the user left it, unless that spot is no longer on any display.
  const { x, y } = savedState;
  const placed = typeof x === "number" && typeof y === "number" && screen.getAllDisplays().some(({ workArea: area }) =>
    x < area.x + area.width && x + width > area.x && y < area.y + area.height && y + height > area.y);

  const iconCandidate = path.join(__dirname, "../resources/icon.png");

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    ...(placed ? { x, y } : { center: true }),
    frame: false,
    autoHideMenuBar: true,
    title: "QoneAgent",
    icon: fs.existsSync(iconCandidate) ? iconCandidate : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: restricted || administratorRequested,
      devTools: !restricted && !administratorRequested,
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: "#1e1e1e",
    show: true,
    alwaysOnTop: true,
  });

  if (!placed) win.center();
  if (savedState.maximized) win.maximize();
  win.show();
  win.focus();

  setTimeout(() => {
    if (!win.isDestroyed()) {
      win.setAlwaysOnTop(false);
    }
  }, 2000);

  win.on("resized", () => {
    win.webContents.send("window:resized");
    saveWindowState();
  });

  win.on("moved", () => {
    win.webContents.send("window:moved");
    saveWindowState();
  });

  win.on("close", () => {
    saveWindowState();
  });

  const devUrl = process.env.VITE_DEV_SERVER_URL || "http://127.0.0.1:1480";
  if (restricted || administratorRequested) {
    win.webContents.on("will-frame-navigate", (event) => event.preventDefault());
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  } else {
    // The preload hands the full desktop bridge to whatever page this window shows:
    // only Qone's own UI may load here, links go to the system browser.
    const appUrl = isDev ? `${new URL(devUrl).origin}/` : "app://localhost/";
    win.webContents.on("will-navigate", (event, url) => {
      if (url.startsWith(appUrl)) return;
      event.preventDefault();
      openExternalLink(url);
    });
    win.webContents.setWindowOpenHandler(({ url }) => {
      openExternalLink(url);
      return { action: "deny" };
    });
  }
  installContextMenu(win.webContents);
  if (isDev) {
    win.loadURL(devUrl).catch(() => {
      setTimeout(() => win.loadURL(devUrl).catch(() => {}), 1500);
    });
  } else {
    win.loadURL("app://localhost/");
  }

  installDevtoolsShortcutGuard(win.webContents);

  win.webContents.on("did-finish-load", () => {
    win.show();
    win.focus();
    win.flashFrame(true);
  });

  return win;
}

function createTray(): void {
  const iconPath = path.join(__dirname, "../resources/icon.png");
  if (!fs.existsSync(iconPath)) return;
  tray = new Tray(iconPath);
  updateTrayMenu();
  tray.setToolTip("QoneAgent");
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

function updateTrayMenu(): void {
  tray?.setContextMenu(Menu.buildFromTemplate([
    {
      label: nativeCopy.show,
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: nativeCopy.quit,
      click: () => {
        app.quit();
      },
    },
  ]));
}

function startDesktop(): void {
  // Started before app ready so the registry read overlaps Electron startup.
  const systemPathReady = refreshWindowsPath();
  const administratorReady = administratorRequested
    ? tryAdministratorTerminal(path.join(process.resourcesPath, "binaries", "qone-terminal-worker.mjs"), administratorLifetime.signal)
      .then(host => {
        if (administratorLifetime.signal.aborted) { host?.stop(); return; }
        terminal.administratorHost = sidecar.administratorHost = host;
      })
    : Promise.resolve();
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ensureGlobalInstructions();
    installApplicationMenu();

    // 处理 app:// 生产页面协议
    protocol.handle("app", (request) => {
      try {
        const url = new URL(request.url);
        let pathname = decodeURIComponent(url.pathname);
        if (pathname.startsWith("/")) {
          pathname = pathname.slice(1);
        }
        if (!pathname || pathname === "/") {
          pathname = "index.html";
        }
        const distDir = path.join(__dirname, "../dist");
        let targetPath = path.resolve(distDir, pathname);
        if (!targetPath.startsWith(distDir + path.sep)) return new Response("Not Found", { status: 404 });
        if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
          targetPath = path.join(distDir, "index.html");
        }
        return net.fetch(pathToFileURL(targetPath).toString());
      } catch (e) {
        console.error("[protocol:app] failed to fetch:", e);
        return new Response("Not Found", { status: 404 });
      }
    });

    // 处理 asset:// 协议；媒体的 Range 请求按片段从磁盘读取，可拖动进度
    protocol.handle("asset", (request) => {
      let filePath = decodeURIComponent(new URL(request.url).pathname);
      if (process.platform === "win32" && filePath.startsWith("/")) {
        filePath = filePath.slice(1);
      }
      // 仅允许访问渲染进程已授权预览的文件，内置浏览器页共享同一 session。
      if (!isAuthorizedAsset(filePath)) return new Response("Forbidden", { status: 403 });
      const range = request.headers.get("Range");
      if (range) return localRangeResponse(filePath, range, request.method);
      return net.fetch(pathToFileURL(filePath).toString());
    });

    registerIpcHandlers(() => mainWindow, sidecar, terminal, browserDock, updater, {
      restricted: restricted || administratorRequested, systemPathReady, administratorReady, administratorSupported,
    }, updateTrayMenu);

    void sidecar.start(Promise.all([systemPathReady, administratorReady]).then(() => {}));
    mainWindow = createMainWindow();
    createTray();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on("will-quit", () => {
    saveWindowState();
    sidecar.stop();
    updater.installDeferredUpdate();
    terminal.killAll();
    administratorLifetime.abort();
    terminal.administratorHost?.stop();
    browserDock.closeAll();
  });
}

async function bootstrap(): Promise<void> {
  if (!app.requestSingleInstanceLock()) {
    app.quit();
    return;
  }
  // Clear the old endpoint while the lock is held, before Electron writes this launch’s port.
  fs.rmSync(devtoolsPortFile, { force: true });
  startDesktop();
}

void bootstrap().catch((error) => {
  console.error("[startup] Could not start Qone:", error);
  app.exit(1);
});
