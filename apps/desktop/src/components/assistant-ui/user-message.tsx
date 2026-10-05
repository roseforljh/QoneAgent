import { MessagePrimitive, useAuiState, useMessageQuote } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { cn } from "../../lib/utils";
import { memo } from "react";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import annotationIcon from "../../assets/codex-icons/text-bubble-light-16.svg";
import { File } from "./elements/file";
import { UserImageThumbnail } from "./elements/user-image-thumbnail";
import { UserMessageActions } from "./message-actions";
import { UserMessageEditComposer } from "./user-message-edit";
import { MarkdownText } from "./markdown-text";

function UserMessageText({ paired = false }: { paired?: boolean }) {
  const parts = useAuiState((state) => state.message.parts);
  const textPartIndexes = parts.flatMap((part, index) => part.type === "text" && part.text.length > 0 ? [index] : []);
  if (textPartIndexes.length === 0) return null;
  return (
    <div data-aui-quote-selectable="true" className={cn("q-user-message-bubble w-fit min-w-0 break-words text-start", paired ? "q-user-message-bubble-paired max-w-[70%]" : "max-w-[70%]")}>
      {textPartIndexes.map((index) => <MessagePrimitive.PartByIndex key={index} index={index} components={{ Text: MarkdownText }} />)}
    </div>
  );
}

function UserMessageAnnotation() {
  const { t } = useLocale();
  const quote = useMessageQuote();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const show = () => { cancelClose(); setOpen(true); };
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 100); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  if (!quote) return null;
  return <Popover.Root open={open} onOpenChange={(next) => { cancelClose(); setOpen(next); }}>
    <div className="q-message-annotation" onMouseEnter={show} onMouseLeave={scheduleClose}>
      <Popover.Trigger asChild>
        <button type="button" className="q-message-annotation-trigger" aria-label={t("chat.annotationLabel")} onClick={(event) => { event.preventDefault(); show(); }}>
          <CodexIcon src={annotationIcon} className="size-4 shrink-0" />
          <span>{t("chat.annotationLabel")}</span>
        </button>
      </Popover.Trigger>
    </div>
    <Popover.Portal>
      <Popover.Content className="q-message-annotation-preview" aria-label={t("chat.selectedText")}
        side="top" align="end" sideOffset={4} collisionPadding={8}
        onMouseEnter={show} onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
        <span>{quote.text}</span>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

export const UserMessage = memo(function UserMessage() {
  const editing = useAuiState((state) => state.message.composer.isEditing);
  return (
    <MessagePrimitive.Root className="q-message-root q-message-user q-user-message-group relative mx-auto flex w-full q-thread-content flex-col items-end gap-1">
      {editing ? <UserMessageEditComposer /> : <>
        <UserMessageAnnotation />
        <UserMessageAttachments />
        <UserMessageText />
        <div className="q-user-message-action-slot"><UserMessageActions /></div>
      </>}
    </MessagePrimitive.Root>
  );
});

export function UserMessageContent() {
  const editing = useAuiState((state) => state.message.composer.isEditing);
  return (
    // The top-anchor measures this root; keep the attachment and bubble in it.
    <MessagePrimitive.Root className="q-message-root q-message-user relative flex w-full flex-col items-end gap-1 self-end">
      {editing ? <UserMessageEditComposer /> : <>
        <UserMessageAnnotation />
        <UserMessageAttachments />
        <UserMessageText paired />
      </>}
    </MessagePrimitive.Root>
  );
}

export function UserMessageAttachments() {
  const hasAttachments = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "file" || part.type === "image",
  ));
  if (!hasAttachments) return null;
  return (
    <div className="q-message-user-attachments flex w-fit max-w-full min-w-0 flex-wrap items-end justify-end gap-2 self-end">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === "file") return <File {...part} />;
          if (part.type === "image") return <UserImageThumbnail {...part} />;
          return null;
        }}
      </MessagePrimitive.Parts>
    </div>
  );
}
