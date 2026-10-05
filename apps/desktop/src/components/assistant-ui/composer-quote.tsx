import { ComposerPrimitive, useAui, useAuiState } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import closeIcon from "../../assets/codex-icons/xmark-md-light-16.svg";
import selectionIcon from "../../assets/codex-icons/text-bubble-light-16.svg";
import pencilIcon from "../../assets/codex-icons/pencil-light-16.svg";
import trashIcon from "../../assets/codex-icons/trash-light-16.svg";
import checkIcon from "../../assets/codex-icons/checkmark-md-light-16.svg";
import "./selected-text.css";

export function ComposerQuote() {
  return <ComposerPrimitive.Quote className="q-composer-quote"><QuoteAttachment /></ComposerPrimitive.Quote>;
}

function QuoteAttachment() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const showPreview = () => { cancelClose(); setOpen(true); };
  // Codex VYe keeps the preview open while crossing the 4px gap to its content.
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 100); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);

  return <Popover.Root open={open} onOpenChange={(next) => { cancelClose(); setOpen(next); }}>
    <div className="q-composer-quote-pill" onMouseEnter={showPreview} onMouseLeave={scheduleClose}>
      <Popover.Trigger asChild>
        <button type="button" className="q-composer-quote-trigger" onClick={(event) => {
          event.preventDefault(); showPreview();
        }}>
          <CodexIcon src={selectionIcon} className="size-3 shrink-0" />
          <span className="q-composer-quote-label">{t("chat.selectedTextAttachment")}</span>
        </button>
      </Popover.Trigger>
      <ComposerPrimitive.QuoteDismiss className="q-composer-quote-remove" aria-label={t("chat.removeSelectedText")} title={t("chat.removeSelectedText")}>
        <span className="q-composer-quote-remove-icon"><CodexIcon src={closeIcon} className="size-3" /></span>
      </ComposerPrimitive.QuoteDismiss>
    </div>
    <Popover.Portal>
      <Popover.Content className="q-composer-quote-preview" aria-label={t("chat.selectedText")}
        side="top" align="start" sideOffset={4} collisionPadding={{ top: 48, right: 6, bottom: 6, left: 6 }}
        onMouseEnter={showPreview} onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
        <QuotePreview />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function QuotePreview() {
  const { t } = useLocale();
  const aui = useAui();
  const quote = useAuiState((state) => state.composer.quote);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(quote?.text ?? "");
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(quote?.text ?? "");
  }, [editing, quote?.text]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  if (!quote) return null;
  const save = () => {
    const text = draft.trim();
    if (text) aui.composer.setQuote({ ...quote, text });
    setEditing(false);
  };
  const cancel = () => {
    setDraft(quote.text);
    setEditing(false);
  };

  return (
    <ol className="q-composer-quote-items">
      <li className="q-composer-quote-item">
        <span className="q-composer-quote-number">1.</span>
        <div className="q-composer-quote-details">
          <span className="q-composer-quote-heading">{t("chat.selectedText")}:</span>
          {editing ? (
            <textarea
              ref={inputRef}
              data-selected-text-editor
              value={draft}
              aria-label={t("chat.selectedText")}
              className="q-composer-quote-editor"
              rows={2}
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") { event.preventDefault(); cancel(); }
                if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); save(); }
              }}
            />
          ) : <span className="q-composer-quote-text">{quote.text}</span>}
        </div>
        <div className="q-composer-quote-actions">
          <button
            type="button"
            className="q-composer-quote-action"
            aria-label={t(editing ? "chat.saveSelectedText" : "chat.editSelectedText")}
            title={t(editing ? "chat.saveSelectedText" : "chat.editSelectedText")}
            onClick={editing ? save : () => setEditing(true)}
          >
            <CodexIcon src={editing ? checkIcon : pencilIcon} className="size-4" />
          </button>
          <ComposerPrimitive.QuoteDismiss
            className="q-composer-quote-action"
            aria-label={t("chat.removeSelectedText")}
            title={t("chat.removeSelectedText")}
          >
            <CodexIcon src={trashIcon} className="size-4" />
          </ComposerPrimitive.QuoteDismiss>
        </div>
      </li>
    </ol>
  );
}
