"use client";

import {
  type PropsWithChildren,
  type FC,
} from "react";
import {
  XIcon,
  PaperclipIcon,
  Loader2Icon,
  AlertCircleIcon,
} from "lucide-react";
import {
  AttachmentPrimitive,
  ComposerPrimitive,
  MessagePrimitive,
  useAuiState,
  useAui,
} from "@assistant-ui/react";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "../../ui/tooltip";
import { TooltipIconButton } from "../tooltip-icon-button";
import { useAttachmentSrc } from "../../../hooks/use-attachment-src";
import { cn } from "../../../lib/utils";
import { Image } from "./image";
import { CodexIcon } from "../../ui/CodexIcon";
import { DIRECTORY_MIME_TYPE } from "@qone/protocol";
import type { NativeAttachmentFile } from "../../../lib/native-attachment-file";
import { useLocale } from "../../../localization";
import { attachmentFileIcon, attachmentFileKind, attachmentFileLabel } from "../../../lib/attachment-file-kind";
import { fileToDataUrl } from "../../../lib/message-file-preview";
import { openWorkspaceFile } from "../../../lib/workspace-file-navigation";
import { useConversationStore } from "../../../lib/conversation-context";

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const { t } = useLocale();
  const src = useAttachmentSrc();
  const filename = useAuiState((state) => state.attachment.name);

  if (!src) return children;
  return <Image.Zoom src={src} alt={filename || t("attachment.imageAlt")} filename={filename}>{children}</Image.Zoom>;
};

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc();
  const name = useAuiState((s) => s.attachment.name);
  const mimeType = useAuiState((s) => s.attachment.contentType ?? s.attachment.file?.type ?? "");
  const kind = attachmentFileKind(name, mimeType);

  return src
    ? <img src={src} alt="" className="aui-attachment-tile-image size-full object-cover" />
    : <span className="flex size-full items-center justify-center" data-attachment-kind={kind}>
        <CodexIcon src={attachmentFileIcon(name, mimeType)} className="aui-attachment-tile-fallback-icon size-5" />
      </span>;
};

const formatAttachmentSize = (bytes: number | undefined): string | undefined => {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const { t } = useLocale();
  const isComposer = aui.attachment.source !== "message";
  const workspaceId = useConversationStore((state) => state.currentWorkspaceId);
  const sessionId = useConversationStore((state) => state.currentSessionId);

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const isDirectory = useAuiState((s) => (s.attachment.file as NativeAttachmentFile | undefined)?.qoneIsDirectory === true || s.attachment.contentType === DIRECTORY_MIME_TYPE);
  const attachmentName = useAuiState((s) => s.attachment.name);
  const mimeType = useAuiState((s) => s.attachment.contentType ?? s.attachment.file?.type ?? "");
  const nativeFile = useAuiState((s) => s.attachment.file as NativeAttachmentFile | undefined);
  const inlineData = useAuiState((s) => s.attachment.content?.find((part) => part.type === "file")?.data ?? "");
  const kind = attachmentFileKind(attachmentName, mimeType);
  const attachmentSize = useAuiState((s) => (s.attachment.file as NativeAttachmentFile | undefined)?.qoneFileSize ?? s.attachment.file?.size);
  const attachmentSizeLabel = formatAttachmentSize(attachmentSize);
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return t("attachment.image");
      case "document":
        return t("attachment.document");
      case "file":
        return t("attachment.file");
      default:
        return type;
    }
  });

  // An attachment on a submission is still being prepared, whether or not the
  // adapter reports progress while it uploads.
  const uploadState = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? "error"
      : s.attachment.status.type === "running"
        ? "uploading"
        : undefined,
  );
  const isUploading = uploadState === "uploading";
  const isError = uploadState === "error";
  const uploadProgress = useAuiState((s) =>
    s.attachment.status.type === "running"
      ? Math.max(0, Math.min(100, s.attachment.status.progress))
      : 0,
  );
  const attachmentMeta = isUploading
    ? t("attachment.uploading")
    : isError
      ? t("attachment.uploadFailed")
      : isDirectory ? t("composer.toolFolder") : [attachmentFileLabel(attachmentName, mimeType), attachmentSizeLabel].filter(Boolean).join(" · ");

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? t("attachment.uploadFailed"))
      : undefined,
  );
  const previewable = isComposer && !isImage && !isDirectory && !isUploading && Boolean(
    nativeFile?.qoneLocalPath || inlineData || nativeFile,
  );
  const openPreview = async () => {
    if (!previewable) return;
    const localPath = nativeFile?.qoneLocalPath;
    const data = localPath ? "" : inlineData || (nativeFile ? await fileToDataUrl(nativeFile, mimeType) : "");
    if (!localPath && !data) return;
    openWorkspaceFile({
      sessionId,
      workspaceId,
      path: (localPath ?? attachmentName) || t("attachment.file"),
      attachment: localPath ? undefined : { data, mimeType },
    });
  };

  return (
    <TooltipProvider>
      <Tooltip>
        <AttachmentPrimitive.Root
          className={cn(
            "aui-attachment-root relative",
            isComposer &&
              "min-w-0 max-w-[min(100%,12rem)] flex-[0_1_12rem] animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none",
            isImage &&
              !isComposer &&
              "aui-attachment-root-message only:*:first:size-24",
          )}
        >
          <AttachmentPreviewDialog>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "aui-attachment-tile bg-foreground/[0.04] hover:after:bg-foreground/10 focus-visible:ring-ring/50 relative flex min-w-0 max-w-[min(100%,12rem)] cursor-pointer items-center gap-2.5 overflow-hidden rounded-[14px] py-1.5 ps-1.5 pe-7 outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:transition-colors after:ring-inset focus-visible:ring-1 dark:bg-foreground/[0.06] dark:after:ring-white/10",
                  isComposer && "w-full",
                  isError &&
                    "after:ring-destructive/60 dark:after:ring-destructive/60",
                  previewable && "cursor-pointer",
                )}
                data-state={isError ? "error" : isUploading ? "uploading" : "done"}
                data-attachment-kind={kind}
                role={previewable ? "button" : undefined}
                tabIndex={previewable ? 0 : undefined}
                aria-label={t("attachment.label", { name: attachmentName || typeLabel }) + (isError || isUploading ? `, ${attachmentMeta}` : "")}
                onClick={previewable ? () => void openPreview() : undefined}
                onKeyDown={previewable ? (event) => {
                  if (event.key !== "Enter" && event.key !== " ") return;
                  event.preventDefault();
                  void openPreview();
                } : undefined}
              >
                <div className="aui-attachment-tile-thumb size-8 shrink-0 overflow-hidden rounded-[8px]">
                  <AttachmentThumb />
                </div>
                <span className="aui-attachment-tile-name flex min-w-0 flex-1 flex-col text-start">
                  <span className="truncate text-xs font-medium text-foreground">
                    <AttachmentPrimitive.Name />
                  </span>
                  {attachmentMeta && (
                    <span className={cn(
                      "text-xs leading-4",
                      isError ? "text-destructive/80" : "text-foreground/40",
                    )}>
                      {attachmentMeta}
                    </span>
                  )}
                </span>
                <span className="ms-1 flex w-5 shrink-0 items-center justify-end" aria-hidden="true">
                  {isUploading ? (
                    <Loader2Icon className="text-foreground/35 size-3.5 animate-spin motion-reduce:animate-none" />
                  ) : isError ? (
                    <AlertCircleIcon className="text-destructive size-3.5" />
                  ) : null}
                </span>
                {isUploading && (
                  <span
                    aria-hidden="true"
                    className="aui-attachment-tile-progress bg-blue-500/70 absolute inset-x-0 bottom-0 h-0.5 transition-[width] duration-300 dark:bg-blue-400/70"
                    style={{ width: `${uploadProgress}%` }}
                  />
                )}
              </div>
            </TooltipTrigger>
          </AttachmentPreviewDialog>
          {isComposer && !isUploading && <AttachmentRemove />}
        </AttachmentPrimitive.Root>
        <TooltipContent side="top">
          <AttachmentPrimitive.Name />
          {errorMessage && (
            <p className="aui-attachment-error-message">{errorMessage}</p>
          )}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

const AttachmentRemove: FC = () => {
  const { t } = useLocale();
  return (
    <AttachmentPrimitive.Remove render={<TooltipIconButton tooltip={t("attachment.remove")} className="aui-attachment-tile-remove absolute end-1 top-1/2 size-5 -translate-y-1/2 rounded-full text-foreground/45 hover:bg-foreground/[0.06]! hover:text-foreground/90! active:scale-[0.96] motion-reduce:transition-none dark:hover:bg-foreground/[0.09]!" side="top" />}>
      <XIcon className="aui-attachment-remove-icon size-3 stroke-[2.5]" />
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>
        {() => <AttachmentUI />}
      </MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC<PropsWithChildren> = ({ children }) => {
  // Codex keeps this slot's top/bottom padding even when it has no attachments.
  // The editor has no block padding, so hiding the empty slot removes its top inset.
  return (
    <div className="aui-composer-attachments flex w-full min-w-0 flex-wrap items-center gap-2 px-2 pb-1.5 pt-2">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
      {children}
    </div>
  );
};

export const ComposerAddAttachment: FC<{ hidden?: boolean }> = ({ hidden = false }) => {
  const { t } = useLocale();
  return (
    <ComposerPrimitive.AddAttachment render={<TooltipIconButton
        tooltip={t("attachment.add")}
        side="bottom"
        variant="ghost"
        size="icon"
        className={cn(
          "aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full active:scale-[0.96] motion-reduce:transition-none",
          hidden && "pointer-events-none absolute size-px overflow-hidden opacity-0",
        )}
        aria-label={t("attachment.add")}
      />}>
        <PaperclipIcon className="aui-attachment-add-icon size-4" />
    </ComposerPrimitive.AddAttachment>
  );
};

