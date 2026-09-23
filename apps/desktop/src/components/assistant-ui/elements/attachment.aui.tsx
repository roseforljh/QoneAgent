"use client";

import {
  type PropsWithChildren,
  useState,
  type FC,
  isValidElement,
} from "react";
import {
  XIcon,
  FileText,
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
import {
  Dialog,
  DialogTitle,
  DialogContent,
  DialogTrigger,
} from "../../ui/dialog";
import {
  Avatar,
  AvatarImage,
  AvatarFallback,
} from "../../ui/avatar";
import { TooltipIconButton } from "../tooltip-icon-button";
import { useAttachmentSrc } from "../../../hooks/use-attachment-src";
import { cn } from "../../../lib/utils";

type AttachmentPreviewProps = {
  src: string;
};

const AttachmentPreview: FC<AttachmentPreviewProps> = ({ src }) => {
  const [isLoaded, setIsLoaded] = useState(false);
  return (
    <img
      src={src}
      alt="Attachment preview"
      className={cn(
        "block h-auto max-h-[80vh] w-auto max-w-full rounded-sm object-contain transition-opacity duration-300 motion-reduce:transition-none",
        isLoaded
          ? "aui-attachment-preview-image-loaded opacity-100"
          : "aui-attachment-preview-image-loading opacity-0",
      )}
      onLoad={() => setIsLoaded(true)}
    />
  );
};

const AttachmentPreviewDialog: FC<PropsWithChildren> = ({ children }) => {
  const src = useAttachmentSrc();

  if (!src) return children;

  return (
    <Dialog>
      <DialogTrigger
        className="aui-attachment-preview-trigger cursor-zoom-in"
        asChild
      >
        {isValidElement(children) ? (
          children
        ) : (
          <button type="button">{children}</button>
        )}
      </DialogTrigger>
      <DialogContent className="aui-attachment-preview-dialog-content [&>button]:bg-foreground/60 [&>button]:hover:bg-foreground/80 [&_svg]:text-background p-2 sm:max-w-3xl [&>button]:rounded-full [&>button]:p-1 [&>button]:opacity-100 [&>button]:ring-0!">
        <DialogTitle className="aui-sr-only sr-only">
          Image Attachment Preview
        </DialogTitle>
        <div className="aui-attachment-preview bg-background relative mx-auto flex max-h-[80dvh] w-full items-center justify-center overflow-hidden rounded-sm">
          <AttachmentPreview src={src} />
        </div>
      </DialogContent>
    </Dialog>
  );
};

const AttachmentThumb: FC = () => {
  const src = useAttachmentSrc();

  return (
    <Avatar className="aui-attachment-tile-avatar h-full w-full rounded-none">
      <AvatarImage
        src={src}
        alt="Attachment preview"
        className="aui-attachment-tile-image rounded-none object-cover"
      />
      <AvatarFallback>
        <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground/80 size-6 stroke-[1.5]" />
      </AvatarFallback>
    </Avatar>
  );
};

const formatAttachmentSize = (bytes: number | undefined): string | undefined => {
  if (bytes === undefined) return undefined;
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";

  const isImage = useAuiState((s) => s.attachment.type === "image");
  const attachmentName = useAuiState((s) => s.attachment.name);
  const attachmentSize = useAuiState((s) => s.attachment.file?.size);
  const attachmentSizeLabel = formatAttachmentSize(attachmentSize);
  const typeLabel = useAuiState((s) => {
    const type = s.attachment.type;
    switch (type) {
      case "image":
        return "Image";
      case "document":
        return "Document";
      case "file":
        return "File";
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
    ? "上传中"
    : isError
      ? "上传失败"
      : attachmentSizeLabel;

  const errorMessage = useAuiState((s) =>
    s.attachment.status.type === "incomplete" &&
    s.attachment.status.reason === "error"
      ? (s.attachment.status.message ?? "Upload failed")
      : undefined,
  );

  return (
    <TooltipProvider>
      <Tooltip>
        <AttachmentPrimitive.Root
          className={cn(
            "aui-attachment-root relative",
            isComposer &&
              "animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none",
            isImage &&
              !isComposer &&
              "aui-attachment-root-message only:*:first:size-24",
          )}
        >
          <AttachmentPreviewDialog>
            <TooltipTrigger asChild>
              <div
                className={cn(
                  "aui-attachment-tile bg-foreground/[0.04] hover:after:bg-foreground/10 focus-visible:ring-ring/50 relative flex min-w-0 max-w-[min(100%,22rem)] cursor-pointer items-center gap-2.5 overflow-hidden rounded-[14px] py-1.5 ps-1.5 pe-7 transition-transform outline-none after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:transition-colors after:ring-inset focus-visible:ring-1 active:scale-[0.98] motion-reduce:transition-none dark:bg-foreground/[0.06] dark:after:ring-white/10",
                  isError &&
                    "after:ring-destructive/60 dark:after:ring-destructive/60",
                )}
                data-state={isError ? "error" : isUploading ? "uploading" : "done"}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    e.currentTarget.click();
                  } else if (e.key === " ") {
                    e.preventDefault();
                  }
                }}
                onKeyUp={(e) => {
                  if (e.key === " ") e.currentTarget.click();
                }}
                aria-label={`${attachmentName || typeLabel} attachment${
                  isError ? ", upload failed" : isUploading ? ", uploading" : ""
                }`}
              >
                <div className="aui-attachment-tile-thumb bg-background/70 size-8 shrink-0 overflow-hidden rounded-[10px] dark:bg-white/10">
                  <AttachmentThumb />
                </div>
                <span className="aui-attachment-tile-name flex min-w-0 flex-1 flex-col text-start">
                  <span className="max-w-36 truncate text-xs font-medium text-foreground">
                    <AttachmentPrimitive.Name />
                  </span>
                  {attachmentMeta && (
                    <span className={cn(
                      "text-[11px] leading-4",
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
  return (
    <AttachmentPrimitive.Remove render={<TooltipIconButton tooltip="Remove file" className="aui-attachment-tile-remove absolute end-1 top-1/2 size-5 -translate-y-1/2 rounded-full text-foreground/45 hover:bg-foreground/[0.06]! hover:text-foreground/90! active:scale-[0.96] motion-reduce:transition-none dark:hover:bg-foreground/[0.09]!" side="top" />}>
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

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>
        {() => <AttachmentUI />}
      </ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC<{ hidden?: boolean }> = ({ hidden = false }) => {
  return (
    <ComposerPrimitive.AddAttachment render={<TooltipIconButton
        tooltip="Add Attachment"
        side="bottom"
        variant="ghost"
        size="icon"
        className={cn(
          "aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 dark:border-muted-foreground/15 dark:hover:bg-muted-foreground/30 size-7 rounded-full active:scale-[0.96] motion-reduce:transition-none",
          hidden && "pointer-events-none absolute size-px overflow-hidden opacity-0",
        )}
        aria-label="Add Attachment"
      />}>
        <PaperclipIcon className="aui-attachment-add-icon size-4" />
    </ComposerPrimitive.AddAttachment>
  );
};

