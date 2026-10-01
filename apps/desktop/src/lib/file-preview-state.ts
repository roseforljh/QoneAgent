import { localizeError } from "../lib/error-localization";
import { create } from "zustand";
import type { FilePreviewInfo, RuntimeCommand, RuntimeEvent } from "@qone/protocol";

interface FilePreviewState {
  requestId: string;
  path: string;
  file?: FilePreviewInfo;
  loading: boolean;
  error?: string;
}

export const useFilePreviewStore = create<{ views: Record<string, FilePreviewState> }>(() => ({ views: {} }));
const requests = new Map<string, string>();

function updateRequest(requestId: string, change: (view: FilePreviewState) => FilePreviewState): boolean {
  const ownerId = requests.get(requestId);
  if (!ownerId) return false;
  requests.delete(requestId);
  useFilePreviewStore.setState((state) => {
    const view = state.views[ownerId];
    return view?.requestId === requestId ? { views: { ...state.views, [ownerId]: change(view) } } : state;
  });
  return true;
}

export async function requestFilePreview(ownerId: string, target: { path: string; workspaceId?: string; full?: boolean }, send: (command: RuntimeCommand) => Promise<boolean>): Promise<void> {
  const requestId = crypto.randomUUID();
  requests.set(requestId, ownerId);
  useFilePreviewStore.setState((state) => ({ views: { ...state.views, [ownerId]: {
    requestId, path: target.path, loading: true,
    file: state.views[ownerId]?.path === target.path ? state.views[ownerId]?.file : undefined,
  } } }));
  try {
    if (!await send({ type: "file.preview", requestId, ...target })) dispatchFilePreviewError(requestId, "disconnected");
  } catch (error) { dispatchFilePreviewError(requestId, localizeError(error)); }
}

export function dispatchFilePreview(message: Extract<RuntimeEvent, { type: "file.preview" }>): void {
  updateRequest(message.requestId, (view) => message.path === view.path
    ? { ...view, file: message.file, loading: false, error: undefined }
    : { ...view, loading: false, error: "mismatched-path" });
}

export function dispatchFilePreviewError(requestId: string | undefined, error: string): boolean {
  return Boolean(requestId && updateRequest(requestId, (view) => ({ ...view, loading: false, error })));
}

export function removeFilePreview(ownerId: string): void {
  // Retain pending request ownership until the response arrives, so a closed
  // tab's late error never becomes a conversation error.
  useFilePreviewStore.setState((state) => {
    const views = { ...state.views };
    delete views[ownerId];
    return { views };
  });
}

export function disconnectFilePreviews(): void {
  requests.clear();
  useFilePreviewStore.setState((state) => ({ views: Object.fromEntries(Object.entries(state.views).map(([id, view]) => [id, { ...view, loading: false, error: "disconnected" }])) }));
}
