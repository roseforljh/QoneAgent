"use client";

import { useEffect, useState } from "react";
import { useAuiState } from "@assistant-ui/react";
import { useShallow } from "zustand/react/shallow";
import { localImagePreview } from "../lib/local-image-preview";

const useFileSrc = (file: File | undefined) => {
  const [entry, setEntry] = useState<{ file: File; url: string } | undefined>(
    undefined,
  );

  useEffect(() => {
    // The object URL is a browser resource whose lifetime has to straddle
    // commit, so allocation, revocation, and clearing the entry that names a
    // revoked URL all belong to the effect.
    if (!file) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setEntry(undefined);
      return;
    }

    const objectUrl = URL.createObjectURL(file);
    setEntry({ file, url: objectUrl });

    return () => {
      URL.revokeObjectURL(objectUrl);
    };
  }, [file]);

  return entry !== undefined && entry.file === file ? entry.url : undefined;
};

type AttachmentPreviewSource = { file?: File; src?: string; localPath?: string };

export const useAttachmentSrc = () => {
  const source = useAuiState(
    useShallow((s): { file?: File; src?: string; localPath?: string } => {
      if (s.attachment.type !== "image") return {};
      if (s.attachment.file) {
        const path = (s.attachment.file as File & { qoneLocalPath?: string }).qoneLocalPath;
        return path ? { localPath: path } : { file: s.attachment.file };
      }
      const src = s.attachment.content?.filter((c) => c.type === "image")[0]
        ?.image;
      if (!src) return {};
      return { src };
    }),
  );
  return useAttachmentPreviewSrc(source);
};

/** Shared by attachment chips and queued input thumbnails. */
export const useAttachmentPreviewSrc = ({ file, src, localPath }: AttachmentPreviewSource) => {
  const [preview, setPreview] = useState<{ path: string; url: string } | undefined>();
  useEffect(() => {
    if (!localPath) return;
    let active = true;
    void localImagePreview(localPath).then((url) => {
      if (active) setPreview({ path: localPath, url });
    }).catch(() => undefined);
    return () => { active = false; };
  }, [localPath]);

  return useFileSrc(file) ?? (preview && preview.path === localPath ? preview.url : undefined) ?? src;
};
