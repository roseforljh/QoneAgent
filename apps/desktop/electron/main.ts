import {
  app,
  BrowserWindow,
  Menu,
  Tray,
  protocol,
  net,
  screen,
  type Rectangle,
} from "electron";
import path from "node:path";
import fs from "node:fs";
import netNode from "node:net";
import { pathToFileURL } from "node:url";
import { ensureGlobalInstructions, getRuntimeDir } from "./data-paths";
import { SidecarManager } from "./sidecar";
import { TerminalManager } from "./terminal-manager";
import { BrowserDockManager } from "./browser-dock-manager";
import { registerIpcHandlers } from "./ipc-handlers";
import { installDevtoolsShortcutGuard } from "./devtools-policy";

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

// 动态分配或读取 CDP 端口
function getCdpPort(): number {
  if (process.env.QONE_WEBVIEW_CDP_PORT) {
    const parsed = parseInt(process.env.QONE_WEBVIEW_CDP_PORT.trim(), 10);
    if (!isNaN(parsed) && parsed > 0) return parsed;
  }
  // 查找一个可用端口
  const server = netNode.createServer();
  server.listen(0, "127.0.0.1");
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 9222;
  server.close();
  return port;
}

const cdpPort = getCdpPort();
process.env.QONE_WEBVIEW_CDP_PORT = String(cdpPort);
app.commandLine.appendSwitch("remote-debugging-port", String(cdpPort));
app.commandLine.appendSwitch("remote-allow-origins", "*");

const isDev = !app.isPackaged && process.env.NODE_ENV !== "production";

let mainWindow: BrowserWindow | null = null;
let tray: Tray | null = null;

const sidecar = new SidecarManager(() => mainWindow);
const terminal = new TerminalManager(() => mainWindow);
const browserDock = new BrowserDockManager(() => mainWindow, cdpPort);

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

function createMainWindow(): BrowserWindow {
  const savedState = loadWindowState();
  const primaryDisplay = screen.getPrimaryDisplay();
  const { width: screenWidth, height: screenHeight } = primaryDisplay.workAreaSize;

  const width = Math.min(savedState.width || 1280, Math.round(screenWidth * 0.9));
  const height = Math.min(savedState.height || 860, Math.round(screenHeight * 0.9));

  const iconCandidate = path.join(__dirname, "../resources/icon.png");

  const win = new BrowserWindow({
    width,
    height,
    minWidth: 800,
    minHeight: 600,
    center: true,
    frame: false,
    autoHideMenuBar: true,
    title: "QoneAgent",
    icon: fs.existsSync(iconCandidate) ? iconCandidate : undefined,
    webPreferences: {
      preload: path.join(__dirname, "preload.cjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
    },
    backgroundColor: "#1e1e1e",
    show: true,
    alwaysOnTop: true,
  });

  win.center();
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
  const contextMenu = Menu.buildFromTemplate([
    {
      label: "Show Qone",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.focus();
        }
      },
    },
    {
      label: "Quit",
      click: () => {
        app.quit();
      },
    },
  ]);
  tray.setToolTip("QoneAgent");
  tray.setContextMenu(contextMenu);
  tray.on("double-click", () => {
    if (mainWindow) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
}

// 单实例锁定
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    ensureGlobalInstructions();

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
        let targetPath = path.join(distDir, pathname);
        if (!fs.existsSync(targetPath) || fs.statSync(targetPath).isDirectory()) {
          targetPath = path.join(distDir, "index.html");
        }
        return net.fetch(pathToFileURL(targetPath).toString());
      } catch (e) {
        console.error("[protocol:app] failed to fetch:", e);
        return new Response("Not Found", { status: 404 });
      }
    });

    // 处理 asset:// 协议
    protocol.handle("asset", (request) => {
      let filePath = decodeURIComponent(new URL(request.url).pathname);
      if (process.platform === "win32" && filePath.startsWith("/")) {
        filePath = filePath.slice(1);
      }
      return net.fetch(pathToFileURL(filePath).toString());
    });

    registerIpcHandlers(() => mainWindow, sidecar, terminal, browserDock);

    mainWindow = createMainWindow();
    createTray();

    sidecar.start();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        mainWindow = createMainWindow();
      }
    });
  });

  app.on("will-quit", () => {
    saveWindowState();
    sidecar.stop();
    terminal.killAll();
    browserDock.closeAll();
  });
}
