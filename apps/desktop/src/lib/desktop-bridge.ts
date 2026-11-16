// The only native boundary between the renderer and the Electron main process.

export interface BridgeAPI {
  invoke: <T = any>(cmd: string, args?: Record<string, any>) => Promise<T>;
  listen: <T = any>(event: string, callback: (event: { payload: T }) => void) => Promise<() => void>;
  convertFileSrc: (filePath: string) => string;
  getPathForFile?: (file: File) => string;
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

export function getPathForFile(file: File): string {
  return getBridge().getPathForFile?.(file) ?? "";
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

export type DragDropEvent =
  | { type: "over"; position: { x: number; y: number } }
  | { type: "drop"; paths: string[]; position: { x: number; y: number } }
  | { type: "leave" };
export type EventCallback<T = any> = (event: { payload: T }) => void;

export function getCurrentWebview() {
  return {
    onDragDropEvent: (callback: EventCallback<DragDropEvent>) => {
      if (typeof window === "undefined") return Promise.resolve(() => {});
      const hasFiles = (event: DragEvent) => Array.from(event.dataTransfer?.types ?? []).includes("Files");
      const onDragOver = (event: DragEvent) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        callback({ payload: { type: "over", position: { x: event.clientX, y: event.clientY } } });
      };
      const onDragLeave = (event: DragEvent) => {
        if (event.relatedTarget !== null) return;
        callback({ payload: { type: "leave" } });
      };
      const onDrop = (event: DragEvent) => {
        if (!hasFiles(event)) return;
        event.preventDefault();
        const paths = Array.from(event.dataTransfer?.files ?? []).map(getPathForFile).filter(Boolean);
        callback({ payload: { type: "drop", paths, position: { x: event.clientX, y: event.clientY } } });
      };
      window.addEventListener("dragenter", onDragOver);
      window.addEventListener("dragover", onDragOver);
      window.addEventListener("dragleave", onDragLeave);
      window.addEventListener("drop", onDrop);
      return Promise.resolve(() => {
        window.removeEventListener("dragenter", onDragOver);
        window.removeEventListener("dragover", onDragOver);
        window.removeEventListener("dragleave", onDragLeave);
        window.removeEventListener("drop", onDrop);
      });
    },
  };
}

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

export async function check(options?: { timeout?: number }): Promise<UpdateResult | null> {
  const result = await invoke<{ version: string } | null>("update_check", { timeout: options?.timeout });
  if (!result?.version) return null;
  return {
    version: result.version,
    downloadAndInstall: async () => {
      await invoke("update_download_and_install", { version: result.version });
    },
  };
}
