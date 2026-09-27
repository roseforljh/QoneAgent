import { useLocale } from "../../localization";
import { QoneSelect } from "../ui/Select";

type ModelOption = { id: string; label: string };

export function SubagentTemporarySettings({ value, modelOptions, onChange }: { value: string; modelOptions: ModelOption[]; onChange: (value: string) => void }) {
  const { t } = useLocale();
  const options = [
    { value: "auto", label: t("subagent.followMainModel"), description: t("subagent.followMainModelDescription") },
    ...modelOptions.map((model) => ({ value: model.id, label: model.label })),
  ];
  const selectedValue = value || "auto";

  return <section className="settings-subagent-temporary">
    <div className="settings-subagent-temporary-card">
      <div>
        <strong>{t("subagent.temporaryModel")}</strong>
        <p>{t("subagent.temporaryModelDescription")}</p>
      </div>
      <QoneSelect
        value={selectedValue}
        options={options}
        onChange={(next) => onChange(next === "auto" ? "" : next)}
        ariaLabel={t("subagent.temporaryModel")}
        placeholder={t("subagent.selectModel")}
        className="settings-subagent-temporary-select"
      />
    </div>
  </section>;
}
