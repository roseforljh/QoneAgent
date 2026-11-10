// One Electron mock for every desktop test in this process. Bun keeps a single
// module-mock registry, so each file registering its own partial `electron`
// mock silently replaces the others. Files call installElectronMock() and then
// reach the state below.
import { mock } from "bun:test";

export const ipcHandlers = new Map<string, (...args: unknown[]) => unknown>();
export const rendererListeners = new Map<string, Set<(...args: unknown[]) => void>>();
export const exposedGlobals: Record<string, unknown> = {};

let installed = false;

export function installElectronMock() {
  if (installed) return;
  installed = true;
  mock.module("electron", () => ({
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
    safeStorage: { isEncryptionAvailable: () => false },
    Notification: class { show() {} },
    shell: { openExternal: async () => undefined, openPath: async () => "", showItemInFolder: () => undefined },
    dialog: { showOpenDialog: async () => ({ canceled: true, filePaths: [] }), showSaveDialog: async () => ({ canceled: true }) },
    WebContentsView: class { setBounds() {} webContents = { loadURL: async () => undefined, on: () => undefined }; },
  }));
}