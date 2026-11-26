import type { MouseEvent } from "react";
import { ActionBarPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useConversationStore } from "../../lib/conversation-context";
import { getDraftComposer } from "../../lib/composer-draft-runtime";
import { returnUserMessageToComposer } from "../../lib/user-message-edit";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import { TooltipIconButton } from "./tooltip-icon-button";
import copyIcon from "../../assets/codex-icons/square-on-square-light-16.svg";
import copiedIcon from "../../assets/codex-icons/checkmark-md-light-16.svg";
import retryIcon from "../../assets/codex-icons/arrow-rotate-counterclockwise-light-16.svg";
import editIcon from "../../assets/codex-icons/pencil-light-16.svg";
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
  const aui = useAui();
  const { t } = useLocale();
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const compacting = useConversationStore((state) => Boolean(state.currentSessionId && state.compactionStatuses[state.currentSessionId]));
  const messageId = useAuiState((state) => state.message.id);
  // An agent-to-agent message is stored as a user turn but is not the person's
  // prompt: it must not receive edit/retry, and it must not shadow the real
  // last user turn that those actions target.
  const agentCommunication = useAuiState((state) => Boolean(state.message.metadata?.custom?.qoneAgentCommunication));
  const isLastUserMessage = useAuiState((state) => {
    for (let index = state.thread.messages.length - 1; index >= 0; index--) {
      const message = state.thread.messages[index]!;
      if (message.role !== "user" || message.metadata?.custom?.qoneAgentCommunication) continue;
      return message.id === messageId;
    }
    return false;
  });
  const running = useAuiState((state) => state.thread.isRunning);
  const editCapability = useAuiState((state) => state.thread.capabilities.edit);
  const hasText = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  ));
  const hasAttachments = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "file" || part.type === "image",
  ));
  const canEdit = !running && !compacting && isLastUserMessage && editCapability && (hasText || hasAttachments);
  if ((!hasText && !canEdit) || agentCommunication) return null;

  const handleEdit = (event: MouseEvent<HTMLButtonElement>) => {
    if (!sessionId) return;
    const thread = aui.thread().__internal_getRuntime?.();
    if (!thread) return;
    const threadEl = event.currentTarget.closest<HTMLElement>(".aui-thread-root");
    void returnUserMessageToComposer({
      sessionId,
      messageId,
      composer: getDraftComposer({ thread }),
      isActive: () => useStore.getState().currentSessionId === sessionId || Boolean(useStore.getState().sideChats[sessionId]),
      focusComposer: () => {
        requestAnimationFrame(() => {
          if (!threadEl?.isConnected) return;
          threadEl.querySelector<HTMLElement>(".aui-lexical-input")?.focus();
        });
      },
      goalLabel: t("composer.toolGoal"),
    });
  };

  return (
    <ActionBarPrimitive.Root autohide="never" className="q-message-actions q-user-message-actions">
      {hasText && <MessageCopyAction />}
      {canEdit && (
        <TooltipIconButton
          tooltip={t("chat.editMessage")}
          side="top"
          className="q-message-action-button"
          onClick={handleEdit}
        >
          <CodexIcon src={editIcon} className="q-message-action-icon" />
        </TooltipIconButton>
      )}
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
