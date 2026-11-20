import { cn } from "../../../lib/utils";

export function RecordSwitch({ checked, disabled, label, onToggle }: {
  checked: boolean; disabled?: boolean; label: string; onToggle: () => void;
}) {
  return <button type="button" role="switch" aria-checked={checked} disabled={disabled}
    className="execution-switch" onClick={onToggle}>
    {label}
    <span className={cn("settings-switch", checked && "is-on")} aria-hidden="true"><span /></span>
  </button>;
}
