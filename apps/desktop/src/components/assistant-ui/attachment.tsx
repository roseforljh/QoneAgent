import { useEffect, useMemo, type FC } from "react";
import { XIcon, PlusIcon, FileText, Loader2Icon, AlertCircleIcon } from "lucide-react";
import { AttachmentPrimitive, ComposerPrimitive, MessagePrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { TooltipIconButton } from "./tooltip-icon-button";
import { cn } from "../../lib/utils";

const AttachmentThumb: FC = () => {
  const file = useAuiState((s) => (s.attachment.type === "image" ? s.attachment.file : undefined));
  const src = useMemo(() => (file ? URL.createObjectURL(file) : undefined), [file]);
  useEffect(() => () => { if (src) URL.revokeObjectURL(src); }, [src]);
  return (
    <div className="flex h-full w-full items-center justify-center">
      {src ? <img src={src} alt="" className="aui-attachment-tile-image h-full w-full rounded-none object-cover" /> : <FileText className="aui-attachment-tile-fallback-icon text-muted-foreground/80 size-6 stroke-[1.5]" />}
    </div>
  );
};

const AttachmentUI: FC = () => {
  const aui = useAui();
  const isComposer = aui.attachment.source !== "message";
  const isUploading = useAuiState((s) => s.attachment.status.type === "running");
  const isError = useAuiState((s) => s.attachment.status.type === "incomplete" && s.attachment.status.reason === "error");
  const name = useAuiState((s) => s.attachment.name);

  return (
    <AttachmentPrimitive.Root className={cn("aui-attachment-root relative", isComposer && "animate-in fade-in-0 zoom-in-95 duration-200 motion-reduce:animate-none")}>
      <div
        className={cn(
          "aui-attachment-tile bg-muted hover:after:bg-foreground/10 relative size-14 overflow-hidden rounded-[calc(var(--composer-radius,1rem)-var(--composer-padding,8px))] transition-transform after:pointer-events-none after:absolute after:inset-0 after:rounded-[inherit] after:ring-1 after:ring-black/10 after:transition-colors after:ring-inset active:scale-[0.96] motion-reduce:transition-none dark:after:ring-white/10",
          isError && "after:ring-destructive/60 dark:after:ring-destructive/60",
        )}
        role="button"
        tabIndex={0}
        title={name}
        aria-label={`${name ?? "attachment"}${isError ? ", upload failed" : isUploading ? ", uploading" : ""}`}
      >
        <AttachmentThumb />
        {isUploading && (
          <div aria-hidden="true" className="aui-attachment-tile-uploading bg-background/60 absolute inset-0 flex items-center justify-center backdrop-blur-[2px]">
            <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
          </div>
        )}
        {isError && (
          <div aria-hidden="true" className="aui-attachment-tile-error bg-background/70 absolute inset-0 flex items-center justify-center backdrop-blur-[2px]">
            <AlertCircleIcon className="text-destructive size-4" />
          </div>
        )}
      </div>
      {isComposer && <AttachmentRemove />}
    </AttachmentPrimitive.Root>
  );
};

const AttachmentRemove: FC = () => {
  return (
    <AttachmentPrimitive.Remove
      render={
        <TooltipIconButton
          tooltip="Remove file"
          className="aui-attachment-tile-remove absolute end-1 top-1 size-5 rounded-full bg-black/50! text-white after:absolute after:-inset-1.5 hover:bg-black/70! hover:text-white! active:scale-[0.96] motion-reduce:transition-none"
          side="top"
        />
      }
    >
      <XIcon className="aui-attachment-remove-icon size-3 stroke-[2.5]" />
    </AttachmentPrimitive.Remove>
  );
};

export const UserMessageAttachments: FC = () => {
  return (
    <div className="aui-user-message-attachments-end col-span-full col-start-1 row-start-1 flex w-full flex-row justify-end gap-2 empty:hidden">
      <MessagePrimitive.Attachments>{() => <AttachmentUI />}</MessagePrimitive.Attachments>
    </div>
  );
};

export const ComposerAttachments: FC = () => {
  return (
    <div className="aui-composer-attachments flex w-full flex-row items-center gap-2 overflow-x-auto empty:hidden">
      <ComposerPrimitive.Attachments>{() => <AttachmentUI />}</ComposerPrimitive.Attachments>
    </div>
  );
};

export const ComposerAddAttachment: FC = () => {
  return (
    <ComposerPrimitive.AddAttachment
      render={
        <TooltipIconButton
          tooltip="Add Attachment"
          side="bottom"
          variant="ghost"
          size="icon"
          className="aui-composer-add-attachment text-muted-foreground hover:text-foreground hover:bg-muted-foreground/15 size-7 rounded-full active:scale-[0.96] motion-reduce:transition-none"
          aria-label="Add Attachment"
        />
      }
    >
      <PlusIcon className="aui-attachment-add-icon size-4" />
    </ComposerPrimitive.AddAttachment>
  );
};
