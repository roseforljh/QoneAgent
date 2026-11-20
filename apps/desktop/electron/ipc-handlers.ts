import { ipcMain, shell, type BrowserWindow } from "electron";
import { SidecarManager } from "./sidecar";
import { TerminalManager } from "./terminal-manager";
import { BrowserDockManager } from "./browser-dock-manager";
import { DesktopUpdater } from "./updater";
import * as secretStore from "./secret-store";
import * as fileDialogs from "./file-dialogs";
import { administratorLaunchEnabled, setAdministratorLaunchEnabled } from "./windows-administrator";
import { updateNativeCopy } from "./native-menus";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  sidecar: SidecarManager,
  terminal: TerminalManager,
  browserDock: BrowserDockManager,
  updater: DesktopUpdater,
  privilege: { restricted: boolean; systemPathReady?: Promise<void>; administratorReady?: Promise<void>; administratorSupported?: boolean } = { restricted: false },
  nativeCopyChanged: () => void = () => {},
): void {
  // 统一 invoke 入口或分命 handlers
  ipcMain.handle("desktop_invoke", async (event, cmd: string, args: Record<string, any> = {}) => {
    const mainWindow = getMainWindow();
    if (privilege.restricted || cmd === "administrator_launch_get" || cmd === "administrator_launch_set") {
      if (event.sender !== mainWindow?.webContents || event.senderFrame?.parent !== null
        || (privilege.administratorSupported && !event.senderFrame.url.startsWith("app://localhost/"))) {
        throw new Error("Desktop command requires the main window");
      }
    }
    switch (cmd) {
      case "administrator_launch_get": {
        if (!privilege.administratorSupported) return null;
        await privilege.administratorReady;
        return { enabled: administratorLaunchEnabled(), elevated: terminal.administratorHost?.active === true };
      }
      case "administrator_launch_set": {
        if (!privilege.administratorSupported || typeof args.enabled !== "boolean") throw new Error("Invalid administrator terminal preference");
        setAdministratorLaunchEnabled(args.enabled);
        return;
      }
      case "frontend_diagnostic": {
        console.log("[qone:frontend]", args.message);
        return;
      }
      case "runtime_send": {
        return sidecar.send(args.cmd);
      }
      case "runtime_restart": {
        return sidecar.restart();
      }
      case "runtime_subscribe": {
        return;
      }
      case "pick_workspace": {
        if (!mainWindow) return null;
        return fileDialogs.pickWorkspace(mainWindow, args.title);
      }
      case "inspect_dropped_file": {
        return fileDialogs.inspectDroppedFile(args.path);
      }
      case "pick_attachment_files": {
        if (!mainWindow) return [];
        return fileDialogs.pickAttachmentFiles(mainWindow, args.title);
      }
      case "pick_attachment_folder": {
        if (!mainWindow) return null;
        return fileDialogs.pickAttachmentFolder(mainWindow, args.title);
      }
      case "authorize_attachment_preview": {
        return fileDialogs.authorizeAttachmentPreview(args.path);
      }
      case "authorize_file_preview": {
        return fileDialogs.authorizeFilePreview(args.path, args.allowedRoot);
      }
      case "save_image_as": {
        if (!mainWindow) return false;
        return fileDialogs.saveImageAs(mainWindow, args.filename, args.data, args.title);
      }
      case "set_native_copy": {
        updateNativeCopy(args.copy);
        nativeCopyChanged();
        return;
      }
      case "secret_set": {
        return secretStore.setSecret(args.key, args.value);
      }
      case "secret_get": {
        return secretStore.getSecret(args.key);
      }
      case "secret_delete": {
        return secretStore.deleteSecret(args.key);
      }
      case "terminal_spawn": {
        await Promise.all([privilege.systemPathReady, privilege.administratorReady]);
        return terminal.spawn(args.terminalId, args.shell, args.cwd, args.cols, args.rows, args.shellArgs);
      }
      case "terminal_write": {
        return terminal.write(args.terminalId, args.data);
      }
      case "terminal_resize": {
        return terminal.resize(args.terminalId, args.cols, args.rows);
      }
      case "terminal_clear": {
        return terminal.clear(args.terminalId);
      }
      case "terminal_kill": {
        return terminal.kill(args.terminalId);
      }
      case "browser_open": {
        return browserDock.open(
          args.browserId,
          args.url,
          args.x,
          args.y,
          args.w,
          args.h,
          args.initializationScript
        );
      }
      case "browser_navigate": {
        return browserDock.navigate(args.browserId, args.url);
      }
      case "browser_preview": {
        return browserDock.preview(args.browserId, args.html);
      }
      case "browser_open_preview_external": {
        return browserDock.openPreviewExternal(args.html);
      }
      case "browser_bounds": {
        return browserDock.bounds(args.browserId, args.x, args.y, args.w, args.h);
      }
      case "browser_visible": {
        return browserDock.setVisible(args.browserId, args.visible);
      }
      case "browser_eval": {
        return browserDock.eval(args.browserId, args.script);
      }
      case "browser_eval_result": {
        return browserDock.evalResult(args.browserId, args.script);
      }
      case "browser_close": {
        return browserDock.close(args.browserId);
      }
      case "opencli_cdp_endpoint": {
        return browserDock.getCdpEndpoint(args.browserId);
      }
      case "browser_take_passkey_request": {
        return browserDock.takePasskeyRequest(args.browserId);
      }
      // 窗口控制
      case "window_minimize": {
        mainWindow?.minimize();
        return;
      }
      case "window_maximize_toggle": {
        if (!mainWindow) return false;
        if (mainWindow.isMaximized()) {
          mainWindow.unmaximize();
          return false;
        } else {
          mainWindow.maximize();
          return true;
        }
      }
      case "window_close": {
        mainWindow?.close();
        return;
      }
      case "window_is_maximized": {
        return mainWindow ? mainWindow.isMaximized() : false;
      }
      // Opener
      case "shell_open_external": {
        return shell.openExternal(args.url);
      }
      case "shell_open_path": {
        return shell.openPath(args.path);
      }
      case "shell_show_item_in_folder": {
        shell.showItemInFolder(args.path);
        return;
      }
      case "update_check": {
        return updater.check(typeof args.timeout === "number" ? args.timeout : undefined);
      }
      case "update_download": {
        return updater.download(typeof args.version === "string" ? args.version : undefined, (percent) => {
          getMainWindow()?.webContents.send("update:progress", percent);
        });
      }
      case "update_install": {
        return updater.install(args.now === true);
      }
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  });
}
