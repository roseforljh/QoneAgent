import { invoke } from "@tauri-apps/api/core";
import { mediaMimeTypeFromName } from "@qone/protocol";
import type { EventCallback } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { DragDropEvent } from "@tauri-apps/api/webview";
import { hasTauriBridge, useStore } from "../store";
import { useCallback, useEffect, type RefObject } from "react";
import { createNativeAttachmentFile, INLINE_ATTACHMENT_LIMIT_BYTES, isAudioVideo } from "./native-attachment-file";

type NativeFilePayload = { name: string; data: string; path?: string; size: number };
type NativeFileInfo = { name: string; path: string; size: number };
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

const decodeBase64 = (value: string) => {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
};

const isInside = (element: HTMLElement | null, position: DropPosition) => {
  if (!element) return false;
  const rect = element.getBoundingClientRect();
  const scale = window.devicePixelRatio || 1;
  return [
    { x: position.x, y: position.y },
    { x: position.x / scale, y: position.y / scale },
  ].some(({ x, y }) => x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom);
};

function fileFromPayload(payload: NativeFilePayload): File {
  const mimeType = getMimeType(payload.name);
  if (payload.path) {
    if (!isAudioVideo(mimeType)) throw new Error(`本地路径仅支持音视频附件：${payload.name}`);
    return createNativeAttachmentFile(payload.name, mimeType, payload.path, payload.size);
  }
  return new File([decodeBase64(payload.data)], payload.name, { type: mimeType });
}

export async function pickNativeAttachmentFiles(): Promise<File[]> {
  const files = await invoke<NativeFileInfo[]>("pick_attachment_files");
  return Promise.all(files.map(async (file) => {
    const mimeType = getMimeType(file.name);
    if (isAudioVideo(mimeType)) return createNativeAttachmentFile(file.name, mimeType, file.path, file.size);
    return fileFromPayload(file.size > INLINE_ATTACHMENT_LIMIT_BYTES
      ? { ...file, data: "" }
      : await invoke<NativeFilePayload>("read_dropped_file", { path: file.path }));
  }));
}

export function useNativeFileDrop(
  targetRef: RefObject<HTMLElement | null>,
  onFiles: (files: File[]) => Promise<void>,
) {
  const addFiles = useCallback(async (paths: string[]) => {
    const files = await Promise.all(paths.map(async (path) => {
      try {
        const mimeType = getMimeType(path);
        const payload = await invoke<NativeFilePayload>("read_dropped_file", { path, metadataOnly: isAudioVideo(mimeType) });
        return fileFromPayload(payload);
      } catch (error) {
        useStore.setState({ lastError: error instanceof Error ? error.message : String(error) });
        return null;
      }
    }));
    await onFiles(files.filter((file): file is File => file !== null));
  }, [onFiles]);

  useEffect(() => {
    if (!hasTauriBridge()) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const handle: EventCallback<DragDropEvent> = (event) => {
      const payload = event.payload;
      if (payload.type !== "drop") return;
      if (!isInside(targetRef.current, payload.position)) return;
      void addFiles(payload.paths);
    };
    void getCurrentWebview().onDragDropEvent(handle).then((dispose) => {
      if (disposed) dispose();
      else unlisten = dispose;
    });
    return () => {
      disposed = true;
      unlisten?.();
    };
  }, [addFiles, targetRef]);
}
