import { ActionBarPrimitive, useAuiState } from "@assistant-ui/react";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import { TooltipIconButton } from "./tooltip-icon-button";
import copyIcon from "../../assets/codex-icons/square-on-square-light-16.svg";
import copiedIcon from "../../assets/codex-icons/checkmark-md-light-16.svg";
import retryIcon from "../../assets/codex-icons/arrow-rotate-counterclockwise-light-16.svg";
import "./message-actions.css";

function MessageCopyAction() {
  const { t } = useLocale();
  const copied = useAuiState((state) => state.message.isCopied);
  return (
    <ActionBarPrimitive.Copy asChild copiedDuration={1500} disabled={copied}>
      <TooltipIconButton
        tooltip={t(copied ? "chat.messageCopied" : "chat.copyMessage")}
        side="top"
        className="q-message-action-button"
      >
        <CodexIcon src={copied ? copiedIcon : copyIcon} className="q-message-action-icon" />
      </TooltipIconButton>
    </ActionBarPrimitive.Copy>
  );
}

export function UserMessageActions() {
  const hasText = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  ));
  if (!hasText) return null;
  return (
    <ActionBarPrimitive.Root autohide="never" className="q-message-actions q-user-message-actions">
      <MessageCopyAction />
    </ActionBarPrimitive.Root>
  );
}

export function AssistantMessageActions() {
  const { t } = useLocale();
  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="q-message-actions">
      <MessageCopyAction />
      <ActionBarPrimitive.Reload asChild>
        <TooltipIconButton tooltip={t("chat.retryMessage")} side="top" className="q-message-action-button">
          <CodexIcon src={retryIcon} className="q-message-action-icon" />
        </TooltipIconButton>
      </ActionBarPrimitive.Reload>
    </ActionBarPrimitive.Root>
  );
}
