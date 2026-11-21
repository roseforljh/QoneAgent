import { useEffect, useRef, useState, type RefObject } from "react";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { $getNearestNodeFromDOMNode, HISTORY_PUSH_TAG } from "lexical";
import { $isDirectiveNode, type DirectiveChipProps, type DirectiveNode } from "@assistant-ui/react-lexical";
import { Popover } from "radix-ui";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import { $createComposerQuote } from "../../lib/composer-tool-editor";
import { inlineQuoteLabel } from "../../lib/inline-quote";
import closeIcon from "../../assets/codex-icons/xmark-md-light-16.svg";
import selectionIcon from "../../assets/codex-icons/text-bubble-light-16.svg";
import pencilIcon from "../../assets/codex-icons/pencil-light-16.svg";
import trashIcon from "../../assets/codex-icons/trash-light-16.svg";
import checkIcon from "../../assets/codex-icons/checkmark-md-light-16.svg";
import "./selected-text.css";

type QuoteActions = { onRemove: () => void; onEdit: (text: string) => void };

/** Selected-text chip at its place in the composer: hover to read, edit or remove it. */
export function ComposerQuoteChip({ directiveId }: DirectiveChipProps) {
  const [editor] = useLexicalComposerContext();
  const anchor = useRef<HTMLSpanElement>(null);
  const withNode = (change: (node: DirectiveNode) => void) => editor.update(() => {
    const node = anchor.current && $getNearestNodeFromDOMNode(anchor.current);
    if ($isDirectiveNode(node)) change(node);
  }, { tag: HISTORY_PUSH_TAG });
  const actions: QuoteActions | undefined = editor.isEditable() ? {
    onRemove: () => withNode((node) => node.remove()),
    onEdit: (text) => withNode((node) => node.replace($createComposerQuote(text))),
  } : undefined;
  return <InlineQuoteChip text={directiveId} anchor={anchor} actions={actions} />;
}

/** The pill shared by the composer chip and, read-only, by sent messages. */
export function InlineQuoteChip({ text, anchor, actions }: { text: string; anchor?: RefObject<HTMLSpanElement | null>; actions?: QuoteActions }) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const cancelClose = () => clearTimeout(closeTimer.current);
  const showPreview = () => { cancelClose(); setOpen(true); };
  // Codex VYe keeps the preview open while crossing the 4px gap to its content.
  const scheduleClose = () => { cancelClose(); closeTimer.current = setTimeout(() => setOpen(false), 100); };
  useEffect(() => () => clearTimeout(closeTimer.current), []);
  const label = inlineQuoteLabel(text);

  return <Popover.Root open={open} onOpenChange={(next) => { cancelClose(); setOpen(next); }}>
    <span ref={anchor} className="q-composer-quote-pill q-inline-quote" data-editable={actions ? "" : undefined} onMouseEnter={showPreview} onMouseLeave={scheduleClose}
      onMouseDownCapture={actions ? (event) => { if (event.button === 0) event.preventDefault(); } : undefined}>
      <Popover.Trigger asChild>
        <button type="button" className="q-composer-quote-trigger" aria-label={`${t("chat.selectedText")}: ${label}`} onClick={(event) => {
          event.preventDefault(); showPreview();
        }}>
          <CodexIcon src={selectionIcon} className="size-3 shrink-0" />
          <span className="q-composer-quote-label">{label}</span>
        </button>
      </Popover.Trigger>
      {actions && <button type="button" className="q-composer-quote-remove" aria-label={t("chat.removeSelectedText")} title={t("chat.removeSelectedText")} onClick={actions.onRemove}>
        <span className="q-composer-quote-remove-icon"><CodexIcon src={closeIcon} className="size-3" /></span>
      </button>}
    </span>
    <Popover.Portal>
      <Popover.Content className="q-composer-quote-preview" aria-label={t("chat.selectedText")}
        side="top" align="start" sideOffset={4} collisionPadding={{ top: 48, right: 6, bottom: 6, left: 6 }}
        onMouseEnter={showPreview} onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
        <QuotePreview text={text} actions={actions} />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}

function QuotePreview({ text, actions }: { text: string; actions?: QuoteActions }) {
  const { t } = useLocale();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(text);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (!editing) setDraft(text);
  }, [editing, text]);

  useEffect(() => {
    if (editing) inputRef.current?.focus();
  }, [editing]);

  const save = () => {
    const next = draft.trim();
    if (next && next !== text) actions?.onEdit(next);
    setEditing(false);
  };
  const cancel = () => {
    setDraft(text);
    setEditing(false);
  };

  return (
    <div className="q-composer-quote-item">
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
        ) : <span className="q-composer-quote-text">{text}</span>}
      </div>
      {actions && <div className="q-composer-quote-actions">
        <button
          type="button"
          className="q-composer-quote-action"
          aria-label={t(editing ? "chat.saveSelectedText" : "chat.editSelectedText")}
          title={t(editing ? "chat.saveSelectedText" : "chat.editSelectedText")}
          onClick={editing ? save : () => setEditing(true)}
        >
          <CodexIcon src={editing ? checkIcon : pencilIcon} className="size-4" />
        </button>
        <button type="button" className="q-composer-quote-action" aria-label={t("chat.removeSelectedText")} title={t("chat.removeSelectedText")} onClick={actions.onRemove}>
          <CodexIcon src={trashIcon} className="size-4" />
        </button>
      </div>}
    </div>
  );
}
