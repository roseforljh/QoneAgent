import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { ModelLogo } from "../assistant-ui/model-logo";

export function ModelCard({ label, description, id, selected, onEdit, onSelect }: {
  label: string;
  description: string;
  id: string;
  selected: boolean;
  onEdit: () => void;
  onSelect: () => void;
}) {
  const { t } = useLocale();
  return (
    <div className={cn("settings-model-card", selected && "is-selected")}>
      <button type="button" className="settings-model-edit" onClick={onEdit} aria-label={t("model.openParameters", { label })}>
        <ModelLogo modelName={label} label={label} size={22} />
        <span className="settings-model-copy">
          <strong title={label}>{label}</strong>
          <small>{description}</small>
        </span>
      </button>
      <label className="settings-model-select">
        <input type="radio" name="settings-current-model" value={id} checked={selected} onChange={onSelect} aria-label={t("model.select", { label })} />
      </label>
    </div>
  );
}
