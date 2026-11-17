import { localizeError } from "../lib/error-localization";
import { invoke } from "./desktop-bridge";
import { translateCurrent } from "../localization";
import { DIRECTORY_MIME_TYPE, fileMimeTypeFromName } from "@qone/protocol";
import type { EventCallback } from "./desktop-bridge";
import { getCurrentWebview } from "./desktop-bridge";
import type { DragDropEvent } from "./desktop-bridge";
import { hasDesktopBridge, useStore } from "../store";
import { useCallback, useEffect, type RefObject } from "react";
import { createNativeAttachmentFile } from "./native-attachment-file";

export type NativeFileInfo = { name: string; path: string; size: number; isDirectory: boolean };
type DropPosition = { x: number; y: number };

const getMimeType = (name: string) => fileMimeTypeFromName(name) ?? "application/octet-stream";

export const fileFromNativeInfo = (file: NativeFileInfo): File =>
  createNativeAttachmentFile(file.name, file.isDirectory ? DIRECTORY_MIME_TYPE : getMimeType(file.name), file.path, file.size, file.isDirectory);

export const isInsideNativeDropTarget = (element: HTMLElement | null, position: DropPosition) => {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  return position.x >= rect.left && position.x < rect.right && position.y >= rect.top && position.y < rect.bottom;
};

export async function inspectNativeDroppedFile(path: string): Promise<File> {
  const file = await invoke<NativeFileInfo>("inspect_dropped_file", { path });
  return fileFromNativeInfo(file);
}

export async function pickNativeAttachmentFiles(): Promise<File[]> {
  const files = await invoke<NativeFileInfo[]>("pick_attachment_files", { title: translateCurrent("attachment.add") });
  return files.map(fileFromNativeInfo);
}

export async function pickNativeAttachmentFolder(): Promise<File[]> {
  const folder = await invoke<NativeFileInfo | null>("pick_attachment_folder", { title: translateCurrent("composer.toolFolder") });
  return folder ? [fileFromNativeInfo(folder)] : [];
}

export async function nativeDroppedDirectories(paths: string[]): Promise<string[]> {
  const files = await Promise.all(paths.map((path) => invoke<NativeFileInfo>("inspect_dropped_file", { path })));
  return files.filter((file) => file.isDirectory).map((file) => file.path);
}

export function useNativeFileDrop(
  targetRef: RefObject<HTMLElement | null>,
  onFiles: (files: File[]) => Promise<void>,
  onHover?: (hovering: boolean) => void,
) {
  const addFiles = useCallback(async (paths: string[]) => {
    const files = await Promise.all(paths.map(async (path) => {
      try {
        return await inspectNativeDroppedFile(path);
      } catch (error) {
        useStore.setState({ lastError: localizeError(error) });
        return null;
      }
    }));
    await onFiles(files.filter((file): file is File => file !== null));
  }, [onFiles]);

  useNativePathDrop(targetRef, addFiles, onHover);
}

export function useNativePathDrop(
  targetRef: RefObject<HTMLElement | null>,
  onPaths: (paths: string[]) => Promise<void>,
  onHover?: (hovering: boolean) => void,
) {
  useEffect(() => {
    if (!hasDesktopBridge()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handle: EventCallback<DragDropEvent> = (event) => {
      const payload = event.payload;
      if (disposed) return;
      if (payload.type === "leave") { onHover?.(false); return; }
      const inside = isInsideNativeDropTarget(targetRef.current, payload.position);
      onHover?.(payload.type !== "drop" && inside);
      if (payload.type === "drop" && inside) {
        void onPaths(payload.paths).catch((error) => useStore.setState({ lastError: localizeError(error) }));
      }
    };
    void getCurrentWebview().onDragDropEvent(handle).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    }).catch((error) => { if (!disposed) useStore.setState({ lastError: localizeError(error) }); });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [onPaths, onHover, targetRef]);
}
