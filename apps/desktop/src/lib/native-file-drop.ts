import { localizeError } from "../lib/error-localization";
import { invoke } from "@tauri-apps/api/core";
import { translateCurrent } from "../localization";
import { DIRECTORY_MIME_TYPE, mediaMimeTypeFromName } from "@qone/protocol";
import type { EventCallback } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { hasTauriBridge, useStore } from "../store";
import { useCallback, useEffect, type RefObject } from "react";
import { createNativeAttachmentFile } from "./native-attachment-file";

export type NativeFileInfo = { name: string; path: string; size: number; isDirectory: boolean };
type DropPosition = { x: number; y: number };

const MIME_TYPES: Record<string, string> = {
  csv: "text/csv",
  doc: "application/msword",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  gif: "image/gif",
  jpeg: "image/jpeg",
  jpg: "image/jpeg",
  json: "application/json",
  md: "text/markdown",
  pdf: "application/pdf",
  png: "image/png",
  ppt: "application/vnd.ms-powerpoint",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  txt: "text/plain",
  webp: "image/webp",
  xls: "application/vnd.ms-excel",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  zip: "application/zip",
};

const getMimeType = (name: string) => {
  const extension = name.split(".").pop()?.toLowerCase();
  return mediaMimeTypeFromName(name) ?? (extension ? MIME_TYPES[extension] : undefined) ?? "application/octet-stream";
};

export const fileFromNativeInfo = (file: NativeFileInfo): File =>
  createNativeAttachmentFile(file.name, file.isDirectory ? DIRECTORY_MIME_TYPE : getMimeType(file.name), file.path, file.size, file.isDirectory);

export const isInsideNativeDropTarget = (element: HTMLElement | null, position: DropPosition, scale = window.devicePixelRatio || 1) => {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  // Tauri supplies physical pixels, while some test/webview paths use CSS pixels.
  return [
    { x: position.x, y: position.y },
    { x: position.x / scale, y: position.y / scale },
  ].some(({ x, y }) => x >= rect.left && x < rect.right && y >= rect.top && y < rect.bottom);
};

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
        const file = await invoke<NativeFileInfo>("inspect_dropped_file", { path });
        return fileFromNativeInfo(file);
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
    if (!hasTauriBridge()) return;
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
