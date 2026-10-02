import { ComposerPrimitive } from "@assistant-ui/react";
import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import closeIcon from "../../assets/codex-icons/xmark-md-light-16.svg";
import selectionIcon from "../../assets/codex-icons/text-bubble-light-16.svg";
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
          <CodexIcon src={selectionIcon} className="size-4 shrink-0" />
          <span className="q-composer-quote-label">{t("chat.selectedTextAttachment")}</span>
        </button>
      </Popover.Trigger>
      <ComposerPrimitive.QuoteDismiss className="q-composer-quote-remove" aria-label={t("chat.removeSelectedText")} title={t("chat.removeSelectedText")}>
        <CodexIcon src={closeIcon} className="size-4" />
      </ComposerPrimitive.QuoteDismiss>
    </div>
    <Popover.Portal>
      <Popover.Content className="q-composer-quote-preview" aria-label={t("chat.selectedText")}
        side="top" align="start" sideOffset={4} collisionPadding={{ top: 48, right: 6, bottom: 6, left: 6 }}
        onMouseEnter={showPreview} onMouseLeave={scheduleClose}
        onOpenAutoFocus={(event) => event.preventDefault()} onCloseAutoFocus={(event) => event.preventDefault()}>
        <ComposerPrimitive.QuoteText />
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
