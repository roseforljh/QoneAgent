import { useEffect, useRef, useState, type RefObject } from "react";
import { useAui, useAuiState } from "@assistant-ui/react";
import { Popover } from "radix-ui";
import { useLocale } from "../../localization";
import { useConversationStore } from "../../lib/conversation-context";
import { conversationSession } from "../../lib/session-execution-state";
import { watchMessageSelection, type MessageSelection } from "../../lib/text-selection";
import { focusConversationComposer, openSelectedTextSideChat } from "../../lib/selected-text-side-chat";
import { localizeError } from "../../lib/error-localization";
import { useStore } from "../../store";
import "./selected-text.css";

/** assistant-ui's global SelectionToolbar lacks container scoping and collision
 * handling. Keep its composer quote API; use our scoped selection + Radix anchor. */
export function SelectedTextActions({ scopeRef }: { scopeRef: RefObject<HTMLDivElement | null> }) {
  const { t } = useLocale();
  const aui = useAui();
  const session = useConversationStore(conversationSession);
  const disabled = useAuiState((state) => state.thread.isDisabled);
  const [selection, setSelection] = useState<MessageSelection | null>(null);
  const toolbar = useRef<HTMLDivElement>(null);
  const virtualRef = useRef({ getBoundingClientRect: () => selection!.rect });
  virtualRef.current = { getBoundingClientRect: () => selection!.rect };
  useEffect(() => {
    setSelection(null);
    const scope = scopeRef.current;
    if (!scope || !session || disabled) return;
    return watchMessageSelection(scope, () => toolbar.current, setSelection);
  }, [scopeRef, session?.id, disabled]);
  if (!selection || !session || disabled) return null;
  const quote = selection.quote;
  const clear = () => { window.getSelection()?.removeAllRanges(); setSelection(null); };
  return <Popover.Root open onOpenChange={(open) => { if (!open) setSelection(null); }}>
    <Popover.Anchor virtualRef={virtualRef} />
    <Popover.Portal>
      <Popover.Content ref={toolbar} className="q-selected-text-actions" role="toolbar" aria-label={t("chat.selectionActions")}
        side="top" sideOffset={8} collisionPadding={8} collisionBoundary={scopeRef.current}
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}
        onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()}>
        <button type="button" onClick={() => {
          aui.thread().composer().setQuote(quote);
          clear(); focusConversationComposer(scopeRef.current);
        }}>{t("chat.selectionAdd")}</button>
        <button type="button" disabled={Boolean(session.sideChat)} onClick={() => {
          clear();
          void openSelectedTextSideChat(session.id, quote).catch((error) => useStore.setState({ lastError: localizeError(error) }));
        }}>{t("chat.selectionSideChat")}</button>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
