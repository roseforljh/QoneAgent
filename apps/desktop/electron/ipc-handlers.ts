import { ipcMain, shell, type BrowserWindow } from "electron";
import { SidecarManager } from "./sidecar";
import { TerminalManager } from "./terminal-manager";
import { BrowserDockManager } from "./browser-dock-manager";
import * as secretStore from "./secret-store";
import * as fileDialogs from "./file-dialogs";

export function registerIpcHandlers(
  getMainWindow: () => BrowserWindow | null,
  sidecar: SidecarManager,
  terminal: TerminalManager,
  browserDock: BrowserDockManager
): void {
  // 统一 invoke 入口或分命 handlers
  ipcMain.handle("desktop_invoke", async (_event, cmd: string, args: Record<string, any> = {}) => {
    const mainWindow = getMainWindow();
    switch (cmd) {
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
        if (args.copy?.completed) {
          sidecar.setCompletedCopy(args.copy.completed);
        }
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
        return terminal.spawn(args.terminalId, args.shell, args.cwd, args.cols, args.rows);
      }
      case "terminal_write": {
        return terminal.write(args.terminalId, args.data);
      }
      case "terminal_resize": {
        return terminal.resize(args.terminalId, args.cols, args.rows);
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
      default:
        throw new Error(`unknown command: ${cmd}`);
    }
  });
}
