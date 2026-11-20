// One Electron mock for every desktop test in this process. Bun keeps a single
// module-mock registry, so each file registering its own partial `electron`
// mock silently replaces the others. Files call installElectronMock() and then
// reach the state below.
import { mock } from "bun:test";

export const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
export const rendererListeners = new Map<string, Set<(...args: unknown[]) => void>>();
export const exposedGlobals: Record<string, unknown> = {};
export const permissionHandlers: unknown[] = [];
export const clipboardWrites: string[] = [];

let installed = false;

export function installElectronMock() {
  if (installed) return;
  installed = true;
  mock.module("electron", () => ({
    app: { isPackaged: false },
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) => { ipcHandlers.set(channel, handler); },
      removeHandler: (channel: string) => { ipcHandlers.delete(channel); },
    },
    ipcRenderer: {
      on: (channel: string, callback: (...args: unknown[]) => void) => {
        const set = rendererListeners.get(channel) ?? new Set();
        set.add(callback);
        rendererListeners.set(channel, set);
      },
      invoke: (channel: string, ...args: unknown[]) => {
        const handler = ipcHandlers.get(channel);
        if (!handler) return Promise.reject(new Error(`no ipc handler for ${channel}`));
        return Promise.resolve(handler({}, ...args));
      },
    },
    contextBridge: {
      exposeInMainWorld: (key: string, value: unknown) => { exposedGlobals[key] = value; },
    },
    webUtils: { getPathForFile: (file: { path?: string }) => file.path ?? "" },
    safeStorage: { isAsyncEncryptionAvailable: async () => false },
    Notification: class { show() {} },
    clipboard: { writeText: (text: string) => { clipboardWrites.push(text); } },
    Menu: {
      buildFromTemplate: (template: unknown[]) => ({ items: template, popup() {} }),
      setApplicationMenu: () => {},
    },
    shell: { openExternal: async () => undefined, openPath: async () => "", showItemInFolder: () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    WebContentsView: class {
      static instances: { destroyed: boolean }[] = [];
      closed = false;
      bounds = { x: 0, y: 0, width: 0, height: 0 };
      zoom = 1;
      listeners = new Map<string, (...args: unknown[]) => void>();
      setBounds(bounds: { x: number; y: number; width: number; height: number }) { this.bounds = bounds; }
      getBounds() { return this.bounds; }
      setVisible() {}
      webContents = {
        session: { setPermissionRequestHandler: (handler: unknown) => { permissionHandlers.push(handler); } },
        loadURL: async (url: string) => { this.calls.push(["loadURL", url]); },
        debugger: {
          attach: () => {},
          sendCommand: async (method: string, params?: unknown) => { this.calls.push([method, params]); },
        },
        on: (event: string, listener: (...args: unknown[]) => void) => { this.listeners.set(event, listener); },
        executeJavaScript: async () => this.pageOverflow,
        getZoomFactor: () => this.zoom,
        setAudioMuted: (muted: boolean) => { this.muted = muted; },
        setZoomFactor: (zoom: number) => { this.zoom = zoom; },
        isDestroyed: () => this.closed,
        close: () => { this.closed = true; },
      };
      pageOverflow: unknown = 0;
      calls: unknown[][] = [];
      muted = false;
      constructor() { (this.constructor as unknown as { instances: unknown[] }).instances.push(this); }
    },
  }));
}