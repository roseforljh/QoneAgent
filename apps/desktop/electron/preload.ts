import { contextBridge, ipcRenderer } from "electron";

const listeners = new Map<string, Set<(...args: any[]) => void>>();

ipcRenderer.on("runtime-event", (_event, payload) => {
  const set = listeners.get("runtime-event");
  if (set) set.forEach((cb) => cb({ payload }));
});

ipcRenderer.on("terminal:data", (_event, payload) => {
  const set = listeners.get("terminal:data");
  if (set) set.forEach((cb) => cb({ payload }));
});

ipcRenderer.on("terminal:exit", (_event, payload) => {
  const set = listeners.get("terminal:exit");
  if (set) set.forEach((cb) => cb({ payload }));
});

ipcRenderer.on("browser:navigated", (_event, payload) => {
  const set = listeners.get("browser:navigated");
  if (set) set.forEach((cb) => cb({ payload }));
});

ipcRenderer.on("browser:loaded", (_event, payload) => {
  const set = listeners.get("browser:loaded");
  if (set) set.forEach((cb) => cb({ payload }));
});

ipcRenderer.on("window:resized", () => {
  const set = listeners.get("window:resized");
  if (set) set.forEach((cb) => cb());
});

ipcRenderer.on("window:moved", () => {
  const set = listeners.get("window:moved");
  if (set) set.forEach((cb) => cb());
});

const bridge = {
  invoke: (cmd: string, args: Record<string, any> = {}) => {
    return ipcRenderer.invoke("desktop_invoke", cmd, args);
  },
  listen: (event: string, callback: (...args: any[]) => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(callback);
    return Promise.resolve(() => {
      set?.delete(callback);
    });
  },
  convertFileSrc: (filePath: string) => {
    const normalized = filePath.replace(/\\/g, "/");
    return `asset://localhost/${normalized.startsWith("/") ? normalized.slice(1) : normalized}`;
  },
};

// 暴露到 window
contextBridge.exposeInMainWorld("electronBridge", bridge);

// 同时提供 __TAURI_INTERNALS__ 垫片以保持向下兼容
contextBridge.exposeInMainWorld("__TAURI_INTERNALS__", {
  invoke: bridge.invoke,
  plugins: {},
});
