import { useLocale } from "../../localization";
import { useRef, useState, type KeyboardEvent as ReactKeyboardEvent, type ReactNode } from "react";
import { Check, ChevronRight } from "lucide-react";
import { Popover } from "radix-ui";
import { cn } from "../../lib/utils";
import { useFloatingBoundaries } from "../../hooks/use-floating-boundaries";

export interface SelectOption {
  value: string;
  label: string;
  description?: string;
  suffix?: ReactNode;
  disabled?: boolean;
}

interface QoneSelectProps {
  value: string;
  options: SelectOption[];
  onChange: (value: string) => void;
  placeholder?: string;
  prefix?: ReactNode;
  ariaLabel?: string;
  disabled?: boolean;
  className?: string;
  triggerClassName?: string;
  menuClassName?: string;
  align?: "start" | "end";
}

export function QoneSelect({
  value,
  options,
  onChange,
  placeholder,
  prefix,
  ariaLabel,
  disabled = false,
  className,
  triggerClassName,
  menuClassName,
  align = "start",
}: QoneSelectProps) {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const boundaries = useFloatingBoundaries(triggerRef, open);
  const selected = options.find((option) => option.value === value);

  const choose = (option: SelectOption) => {
    if (option.disabled) return;
    onChange(option.value);
    setOpen(false);
    triggerRef.current?.focus();
  };

  const moveSelection = (direction: 1 | -1) => {
    const enabled = options.filter((option) => !option.disabled);
    if (enabled.length === 0) return;
    const currentIndex = Math.max(0, enabled.findIndex((option) => option.value === value));
    choose(enabled[(currentIndex + direction + enabled.length) % enabled.length]);
  };

  const handleTriggerKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>) => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (!open) setOpen(true);
      else moveSelection(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // Radix's trigger handles Enter/Space through the button click. Toggling
    // here as well would open and immediately close the controlled popover.
  };

  return (
    <Popover.Root open={open && !disabled} onOpenChange={setOpen}>
      <div className={cn("qone-select", open && !disabled && "is-open", className)}>
        <Popover.Trigger asChild>
          <button
            ref={triggerRef}
            type="button"
            className={cn("qone-select-trigger", triggerClassName)}
            aria-label={ariaLabel}
            aria-haspopup="listbox"
            aria-expanded={open && !disabled}
            disabled={disabled}
            onKeyDown={handleTriggerKeyDown}
          >
            {prefix}
            <span className={cn("qone-select-value", !selected && "is-placeholder")}>{selected?.label ?? placeholder ?? t("common.select")}</span>
            <ChevronRight className="qone-select-chevron" size={16} aria-hidden="true" />
          </button>
        </Popover.Trigger>
        <Popover.Content
          className={cn("qone-select-menu", menuClassName)}
          side="bottom"
          align={align}
          sideOffset={5}
          collisionBoundary={boundaries}
          sticky="always"
          hideWhenDetached
          role="listbox"
          aria-label={ariaLabel}
          onOpenAutoFocus={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            event.preventDefault();
            event.stopPropagation();
            setOpen(false);
            triggerRef.current?.focus();
          }}
        >
          {options.map((option) => (
            <button
              type="button"
              role="option"
              aria-selected={option.value === value}
              aria-disabled={option.disabled}
              className={cn("qone-select-option", option.value === value && "is-selected", option.disabled && "is-disabled")}
              key={option.value}
              disabled={option.disabled}
              onClick={() => choose(option)}
            >
              <span>
                <strong>{option.label}</strong>
                {option.description && <small>{option.description}</small>}
              </span>
              {option.suffix != null ? (
                <div className="flex shrink-0 items-center gap-2">
                  {option.suffix}
                  <span className="flex w-4 shrink-0 items-center" aria-hidden="true">
                    {option.value === value && <Check size={16} />}
                  </span>
                </div>
              ) : option.value === value && <Check size={16} aria-hidden="true" />}
            </button>
          ))}
        </Popover.Content>
      </div>
    </Popover.Root>
  );
}
