// The only native boundary between the renderer and the Electron main process.

export interface BridgeAPI {
  invoke: <T = any>(cmd: string, args?: Record<string, any>) => Promise<T>;
  listen: <T = any>(event: string, callback: (event: { payload: T }) => void) => Promise<() => void>;
  convertFileSrc: (filePath: string) => string;
}

function getBridge(): BridgeAPI {
  if (typeof window !== "undefined" && (window as any).electronBridge) {
    return (window as any).electronBridge;
  }
  // 浏览器降级模式
  return {
    invoke: (cmd: string) => Promise.reject(new Error(`Desktop runtime unavailable for invoke: ${cmd}`)),
    listen: () => Promise.resolve(() => {}),
    convertFileSrc: (path: string) => path,
  };
}

export function isDesktop(): boolean {
  return typeof window !== "undefined" && Boolean((window as any).electronBridge);
}

export const invoke: <T = any>(cmd: string, args?: Record<string, any>) => Promise<T> = (cmd, args) => {
  if (cmd === "runtime_subscribe") {
    return Promise.resolve() as Promise<any>;
  }
  return getBridge().invoke(cmd, args);
};

export const listen: <T = any>(event: string, callback: (event: { payload: T }) => void) => Promise<() => void> = (
  event,
  callback
) => {
  return getBridge().listen(event, callback);
};

export class Channel<T = any> {
  public onmessage?: (data: T) => void;
  constructor() {}
}

export function convertFileSrc(filePath: string): string {
  return getBridge().convertFileSrc(filePath);
}

export function getCurrentWindow() {
  return {
    minimize: () => invoke("window_minimize"),
    toggleMaximize: () => invoke<boolean>("window_maximize_toggle"),
    close: () => invoke("window_close"),
    isMaximized: () => invoke<boolean>("window_is_maximized"),
    onResized: (callback: () => void) => listen("window:resized", () => callback()),
    onMoved: (callback: () => void) => listen("window:moved", () => callback()),
  };
}

export function getCurrentWebview() {
  return {
    onDragDropEvent: (callback: (event: any) => void) => {
      // 在浏览器/Electron中，由标准的 HTML5 dragdrop 事件支持
      return Promise.resolve(() => {});
    },
  };
}

export type DragDropEvent = any;
export type EventCallback<T = any> = (event: { payload: T }) => void;

// Opener API
export async function openUrl(url: string): Promise<void> {
  return invoke("shell_open_external", { url });
}

export async function openPath(path: string): Promise<void> {
  return invoke("shell_open_path", { path });
}

export async function revealItemInDir(path: string): Promise<void> {
  return invoke("shell_show_item_in_folder", { path });
}

// Updater API
export interface UpdateResult {
  version: string;
  downloadAndInstall: () => Promise<void>;
}

export async function check(_options?: { timeout?: number }): Promise<UpdateResult | null> {
  return null;
}
