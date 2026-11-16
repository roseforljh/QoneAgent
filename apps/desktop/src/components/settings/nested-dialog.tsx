import { useRef, type ReactNode } from "react";
import { Dialog } from "radix-ui";
import { X } from "lucide-react";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import "./nested-dialog.css";

/** Settings closes on Escape; a nested dialog must only close itself. */
export function NestedDialog({ open, onOpenChange, title, description, children, footer, wide, focusContent }: {
  open: boolean; onOpenChange: (open: boolean) => void; title: ReactNode; description?: ReactNode; children: ReactNode; footer?: ReactNode; wide?: boolean; focusContent?: boolean;
}) {
  const { t } = useLocale();
  const contentRef = useRef<HTMLDivElement>(null);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nested-dialog-overlay" />
        <Dialog.Content ref={contentRef} tabIndex={-1} className={cn("nested-dialog", wide && "is-wide")}
          onOpenAutoFocus={focusContent ? (event) => { event.preventDefault(); contentRef.current?.focus(); } : undefined}
          onEscapeKeyDown={(event) => event.stopPropagation()} aria-describedby={undefined}>
          <header>
            <div><Dialog.Title>{title}</Dialog.Title>{description && <Dialog.Description>{description}</Dialog.Description>}</div>
            <Dialog.Close className="nested-dialog-close" aria-label={t("common.close")}><X size={16} /></Dialog.Close>
          </header>
          <div className="nested-dialog-body">{children}</div>
          {footer && <footer>{footer}</footer>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

