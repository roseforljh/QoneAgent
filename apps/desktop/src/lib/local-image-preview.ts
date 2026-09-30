import { convertFileSrc, invoke } from "@tauri-apps/api/core";

const previews = new Map<string, Promise<string>>();

/** Scope access to one selected image, then let the webview load it from disk. */
export function localImagePreview(path: string): Promise<string> {
  let preview = previews.get(path);
  if (!preview) {
    preview = invoke<void>("authorize_attachment_preview", { path })
      .then(() => convertFileSrc(path))
      .catch((error: unknown) => { previews.delete(path); throw error; });
    previews.set(path, preview);
  }
  return preview;
}
