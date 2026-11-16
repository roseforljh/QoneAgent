import { convertFileSrc, invoke } from "./desktop-bridge";

// Authorization is per path and the asset URL is a pure mapping, so one entry
// per path is enough. Owners (one per mounted conversation) hold a path while
// they render it; the entry goes away when the last owner releases it.
const previews = new Map<string, Promise<string>>();
const owners = new Map<string, number>();

/** Scope access to one selected image, then let the webview load it from disk. */
export function localImagePreview(path: string): Promise<string> {
  let preview = previews.get(path);
  if (!preview) {
    preview = invoke<void>("authorize_attachment_preview", { path })
      .then(() => convertFileSrc(path))
      .catch((error: unknown) => {
        if (previews.get(path) === preview) previews.delete(path);
        throw error;
      });
    previews.set(path, preview);
  }
  return preview;
}

/** Claim a path for one owner; a later release from another owner keeps it. */
export function retainLocalImagePreview(path: string): void {
  owners.set(path, (owners.get(path) ?? 0) + 1);
}

/** Drop this owner's claim; the cached authorization goes with the last one. */
export function releaseLocalImagePreview(path: string): void {
  const remaining = (owners.get(path) ?? 0) - 1;
  if (remaining > 0) { owners.set(path, remaining); return; }
  owners.delete(path);
  previews.delete(path);
}
