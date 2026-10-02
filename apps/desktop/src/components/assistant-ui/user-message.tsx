import { MessagePrimitive, useAuiState } from "@assistant-ui/react";
import { cn } from "../../lib/utils";
import { File } from "./elements/file";
import { UserImageThumbnail } from "./elements/user-image-thumbnail";
import { UserMessageActions } from "./message-actions";

function UserMessageText({ paired = false }: { paired?: boolean }) {
  const hasText = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "text" && part.text.length > 0,
  ));
  if (!hasText) return null;
  return (
    <div data-aui-quote-selectable="true" className={cn("q-user-message-bubble w-fit min-w-0 break-words text-start", paired ? "q-user-message-bubble-paired max-w-full" : "max-w-[70%]")}>
      <MessagePrimitive.Parts>
        {({ part }) => part.type === "text" ? <span className="whitespace-pre-wrap">{part.text}</span> : null}
      </MessagePrimitive.Parts>
    </div>
  );
}

export function UserMessage() {
  return (
    <MessagePrimitive.Root className="q-message-root q-message-user q-user-message-group relative mx-auto flex w-full q-thread-content flex-col items-end gap-1">
      <UserMessageAttachments />
      <UserMessageText />
      <div className="q-user-message-action-slot"><UserMessageActions /></div>
    </MessagePrimitive.Root>
  );
}

export function UserMessageContent() {
  return (
    <MessagePrimitive.Root className="q-message-root q-message-user relative flex w-fit max-w-[70%] flex-col items-end gap-0.5 self-end">
      <UserMessageText paired />
    </MessagePrimitive.Root>
  );
}

export function UserMessageAttachments() {
  const hasAttachments = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "file" || part.type === "image",
  ));
  if (!hasAttachments) return null;
  return (
    <div className="q-message-user-attachments flex w-fit max-w-[75%] min-w-0 flex-wrap items-end justify-end gap-2 self-end">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === "file") return <div className="w-48 max-w-full min-w-0"><File {...part} /></div>;
          if (part.type === "image") return <UserImageThumbnail {...part} />;
          return null;
        }}
      </MessagePrimitive.Parts>
    </div>
  );
}
