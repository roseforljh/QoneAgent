import { useEffect, useRef, useState } from "react";
import { Popover } from "radix-ui";
import { ChevronRight } from "lucide-react";
import { cn } from "../../lib/utils";

const pad = (value: number) => String(value).padStart(2, "0");
const HOURS = Array.from({ length: 24 }, (_, index) => pad(index));
const MINUTES = Array.from({ length: 60 }, (_, index) => pad(index));

/** Reads typed time like "9", "930", "9:30" or "09：30" as "HH:mm"; undefined when it is not a time. */
export function parseTime(text: string): string | undefined {
  const match = /^(\d{1,2})(?:[:：.]?(\d{2})|[:：.])?$/.exec(text.trim());
  if (!match) return undefined;
  const hour = Number(match[1]);
  const minute = Number(match[2] ?? 0);
  return hour < 24 && minute < 60 ? `${pad(hour)}:${pad(minute)}` : undefined;
}

/** Formats typing as "HH:mm": the colon appears after the hour, and 3–9 can only be a one-digit hour. */
export function maskTime(text: string, previous: string): string {
  let digits = text.replace(/\D/g, "");
  if (/^[3-9]/.test(digits)) digits = `0${digits}`;
  digits = digits.slice(0, 4);
  // Only add the colon while typing forward, so Backspace can delete it.
  return digits.length > 2 || (digits.length === 2 && text.length > previous.length) ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
}

/** "HH:mm" field: type the time, or pick it from an hour column and a minute column. */
export function TimePicker({ value, onChange, disabled, ariaLabel }: {
  value: string; onChange: (value: string) => void; disabled?: boolean; ariaLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(value);
  const contentRef = useRef<HTMLDivElement>(null);
  const [hour = "09", minute = "00"] = value.split(":");
  useEffect(() => setDraft(value), [value]);
  // Invalid text goes back to the last good time.
  const commit = () => { const next = parseTime(draft); if (next) onChange(next); setDraft(next ?? value); };
  const column = (items: string[], selected: string, pick: (item: string) => void) => (
    <div className="schedule-time-column" role="listbox">
      {items.map((item) => <button key={item} type="button" role="option" aria-selected={item === selected}
        className={cn("qone-select-option", item === selected && "is-selected")} onClick={() => pick(item)}>{item}</button>)}
    </div>
  );

  // Portaled so the dialog's scroll area cannot clip it; modal so the wheel scrolls it inside a dialog.
  return <Popover.Root modal open={open && !disabled} onOpenChange={setOpen}>
    <Popover.Anchor asChild>
      <div className={cn("qone-select servers-select schedule-time", open && "is-open")}>
        <div className="qone-select-trigger servers-select-trigger schedule-time-field">
          <input value={draft} onChange={(event) => setDraft(maskTime(event.target.value, draft))} onBlur={commit} disabled={disabled}
            onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); commit(); } }}
            inputMode="numeric" maxLength={5} aria-label={ariaLabel} placeholder="HH:mm" />
          <Popover.Trigger asChild>
            <button type="button" aria-label={ariaLabel} disabled={disabled}><ChevronRight className="qone-select-chevron" size={16} aria-hidden="true" /></button>
          </Popover.Trigger>
        </div>
      </div>
    </Popover.Anchor>
    <Popover.Portal><Popover.Content ref={contentRef} className="qone-select-menu schedule-time-menu" side="bottom" align="start" sideOffset={5} collisionPadding={12}
      onOpenAutoFocus={(event) => {
        event.preventDefault();
        // Start both columns at the current value without scrolling the dialog behind.
        requestAnimationFrame(() => contentRef.current?.querySelectorAll<HTMLElement>('[aria-selected="true"]').forEach((item) => {
          const list = item.parentElement!;
          list.scrollTop = item.offsetTop - list.offsetTop - (list.clientHeight - item.offsetHeight) / 2;
        }));
      }}>
      {column(HOURS, hour, (next) => onChange(`${next}:${minute}`))}
      {column(MINUTES, minute, (next) => { onChange(`${hour}:${next}`); setOpen(false); })}
    </Popover.Content></Popover.Portal>
  </Popover.Root>;
}
