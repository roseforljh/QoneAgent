import { useEffect } from "react";
import { useStore } from "../store";
import type { DockTab } from "../lib/dock-state";
import { addQuoteToDraft, focusConversationComposer, onSelectedTextSideChat } from "../lib/selected-text-side-chat";

export function useSelectedTextSideChat(sessionId: string | undefined, tabs: readonly DockTab[], activeId: string | undefined, activate: (id: string) => void) {
  useEffect(() => onSelectedTextSideChat((request) => {
    if (request.handled || request.sessionId !== sessionId) return;
    const state = useStore.getState();
    const ordered = [...tabs.filter((tab) => tab.id === activeId), ...tabs.filter((tab) => tab.id !== activeId)];
    const tab = ordered.find((tab) => tab.view === "sideChat"
      && state.sideChats[tab.id]?.sideChat?.parentSessionId === sessionId
      && !state.runningSessionIds.includes(tab.id));
    if (!tab) return;
    request.handled = true;
    addQuoteToDraft(tab.id, request.quote);
    activate(tab.id);
    // Newly mounted composers autofocus; an already active one needs focus too.
    for (const scope of document.querySelectorAll<HTMLElement>("[data-conversation-id]")) {
      if (scope.dataset.conversationId === tab.id) focusConversationComposer(scope);
    }
  }), [sessionId, tabs, activeId, activate]);
}
