import { useMemo } from "react";
import { supportsMemorySummary } from "@qone/protocol";
import { useStore } from "../../../store";
import { useLocale } from "../../../localization";
import { QoneSelect } from "../../ui/Select";
import { loadProviderProfiles } from "../provider-profile-store";

export function MemoryModelSetting({ modelId, disabled, onChange }: {
  modelId?: string;
  disabled: boolean;
  onChange: (id: string | null) => void;
}) {
  const { t, locale } = useLocale();
  const configs = useStore(state => state.modelConfigs);
  const loaded = useStore(state => state.modelConfigsLoaded);
  const models = useMemo(() => {
    const providers = new Map(loadProviderProfiles().map(({ id, name }) => [id, name]));
    return configs.filter(supportsMemorySummary).map(({ id, provider, model, config }) => {
      const label = typeof config.displayName === "string" && config.displayName ? config.displayName : model;
      const providerName = providers.get(provider) ?? provider;
      return { value: id, label, description: label === model ? providerName : `${providerName} · ${model}`, providerName };
    }).sort((a, b) => a.providerName.localeCompare(b.providerName, locale) || a.label.localeCompare(b.label, locale));
  }, [configs, locale]);
  const selected = models.find(model => model.value === modelId);
  const unavailable = loaded && Boolean(modelId) && !selected;
  const label = t("memory.model");

  return <div className="memory-model-setting">
    <div className="memory-model-copy" title={t("memory.modelDescription")}>
      <strong>{label}</strong>
      {selected && <span className="memory-model-provider">{selected.providerName}</span>}
    </div>
    <QoneSelect
      className="memory-model-select settings-select-wrap"
      triggerClassName="memory-model-trigger qone-select-trigger-compact settings-value-button"
      menuClassName="settings-dropdown"
      ariaLabel={selected ? `${label}：${selected.label} · ${selected.description}` : label}
      value={modelId ?? ""}
      placeholder={unavailable ? t("memory.modelChoose") : modelId}
      options={[{ value: "", label: t("memory.modelAuto"), description: t("memory.modelAutoDescription") }, ...models]}
      onChange={(id) => { if ((id || undefined) !== modelId) onChange(id || null); }}
      disabled={disabled || !loaded}
      align="end"
    />
    {(unavailable || loaded && !models.length) && <p className="memory-hint memory-model-hint">
      {unavailable ? t("memory.modelUnavailable", { model: modelId ?? "" }) : t("memory.modelEmpty")}
    </p>}
  </div>;
}
