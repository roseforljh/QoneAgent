import { localizeError } from "../lib/error-localization";
import { useEffect, useState } from "react";
import { convertFileSrc, invoke } from "@tauri-apps/api/core";

export function useLocalFilePreview(path: string | undefined, revision: unknown = path, allowedRoot?: string): { url?: string; error?: string } {
  const [preview, setPreview] = useState<{ path?: string; revision?: unknown; url?: string; error?: string }>({});
  useEffect(() => {
    if (!path) return;
    let disposed = false;
    void invoke<string>("authorize_file_preview", { path, allowedRoot }).then((resolved) => {
      if (!disposed) setPreview({ path, revision, url: convertFileSrc(resolved) });
    }, (error: unknown) => {
      if (!disposed) setPreview({ path, revision, error: localizeError(error) });
    });
    return () => { disposed = true; };
  }, [path, revision, allowedRoot]);
  return preview.path === path && preview.revision === revision ? preview : {};
}
