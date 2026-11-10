import { NumberField } from "@base-ui/react/number-field";
import { useEffect, useState } from "react";
import { Slider } from "../ui/Slider";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { SectionHeader, SettingsPageHeader } from "./settings-chrome";

export function CompactionSection() {
  const { t } = useLocale();
  const enabled = useStore((state) => state.autoCompactionEnabled);
  const threshold = useStore((state) => state.compactionThreshold);
  const [draftThreshold, setDraftThreshold] = useState<number | null>(threshold);
  const setCompactionSettings = useStore((state) => state.setCompactionSettings);
  const update = (next: Partial<{ autoCompactionEnabled: boolean; compactionThreshold: number }>) => {
    setCompactionSettings({ autoCompactionEnabled: next.autoCompactionEnabled ?? enabled, compactionThreshold: next.compactionThreshold ?? threshold });
  };
  useEffect(() => setDraftThreshold(threshold), [threshold]);
  const commitThreshold = (value: number | null) => {
    const next = value === null || !Number.isFinite(value) ? threshold : Math.min(95, Math.max(50, Math.round(value)));
    setDraftThreshold(next);
    if (next !== threshold) update({ compactionThreshold: next });
  };

  return (
    <>
      <SettingsPageHeader><SectionHeader eyebrow={t("compaction.eyebrow")} title={t("compaction.title")} /></SettingsPageHeader>
      <section className="settings-compaction-section">
        <div className="settings-compaction-row">
          <div>
            <strong>{t("compaction.autoTitle")}</strong>
            <p>{t("compaction.autoDescription")}</p>
          </div>
          <button
            type="button"
            role="switch"
            aria-label={t("compaction.autoTitle")}
            aria-checked={enabled}
            className={cn("settings-switch", enabled && "is-on")}
            onClick={() => {
              setDraftThreshold(threshold);
              update({ autoCompactionEnabled: !enabled });
            }}
          ><span /></button>
        </div>
        <div className={cn("settings-compaction-threshold", !enabled && "is-disabled")}>
          <div className="settings-compaction-threshold-heading">
            <strong>{t("compaction.thresholdTitle")}</strong>
            <NumberField.Root
              className="settings-compaction-value"
              value={draftThreshold}
              min={50}
              max={95}
              step={1}
              allowOutOfRange
              disabled={!enabled}
              onValueChange={(value) => {
                setDraftThreshold(value);
                if (value !== null && Number.isInteger(value) && value >= 50 && value <= 95) {
                  update({ compactionThreshold: value });
                }
              }}
              onValueCommitted={commitThreshold}
            >
              <NumberField.Input className="settings-compaction-input" aria-label={t("compaction.thresholdTitle")} inputMode="numeric" />
              <span aria-hidden="true">%</span>
            </NumberField.Root>
          </div>
          <Slider
            value={threshold}
            min={50}
            max={95}
            ariaLabel={t("compaction.thresholdTitle")}
            disabled={!enabled}
            onValueChange={(value) => update({ compactionThreshold: value })}
          />
          <p>{t("compaction.thresholdDescription")}</p>
        </div>
      </section>
    </>
  );
}
