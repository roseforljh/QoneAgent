import type { QuoteInfo } from "@assistant-ui/react";
import { composerDrafts } from "./composer-drafts";
import { openSideConversation } from "./side-conversation";

const OPEN_SELECTED_TEXT = "qone-selected-text-side-chat";
export interface SelectedTextSideChatRequest {
  sessionId: string;
  quote: QuoteInfo;
  handled: boolean;
}

export function addQuoteToDraft(sessionId: string, quote: QuoteInfo) {
  const draft = composerDrafts.get(sessionId) ?? { text: "", attachments: [], quote: undefined };
  composerDrafts.set(sessionId, { ...draft, quote });
}

export function onSelectedTextSideChat(callback: (request: SelectedTextSideChatRequest) => void) {
  const listener = (event: Event) => callback((event as CustomEvent<SelectedTextSideChatRequest>).detail);
  window.addEventListener(OPEN_SELECTED_TEXT, listener);
  return () => window.removeEventListener(OPEN_SELECTED_TEXT, listener);
}

export async function openSelectedTextSideChat(sessionId: string, quote: QuoteInfo) {
  const request: SelectedTextSideChatRequest = { sessionId, quote, handled: false };
  window.dispatchEvent(new CustomEvent(OPEN_SELECTED_TEXT, { detail: request }));
  if (request.handled) return;
  await openSideConversation(sessionId, { text: "", attachments: [], quote });
}

export function focusConversationComposer(scope: HTMLElement | null) {
  scope?.querySelector<HTMLElement>('.aui-composer-root [contenteditable="true"], .aui-composer-root textarea')?.focus({ preventScroll: true });
}
