import { useEffect, useState } from "react";
import { useLocale, type MessageKey } from "../../localization";
import { accentPalette, ACCENTS, type Accent } from "../../lib/appearance-colors";
import { saveModeAppearance, setThemeSetting, useAppearance, type ThemeSetting } from "../../lib/appearance";
import { QoneSelect } from "../ui/Select";
import { Slider } from "../ui/Slider";

const accentLabels: Record<Accent, MessageKey> = {
  default: "general.default", blue: "general.blue", green: "general.green", yellow: "general.yellow", pink: "general.pink", orange: "general.orange", purple: "general.purple", black: "general.black", custom: "general.custom",
};

export function AppearanceOptions() {
  const { t } = useLocale();
  const appearance = useAppearance();
  const { resolvedTheme: theme, current, contrast } = appearance;
  const [hexInput, setHexInput] = useState(current.customAccent);
  useEffect(() => setHexInput(current.customAccent), [current.customAccent, theme]);
  const selector = { className: "settings-select-wrap", triggerClassName: "settings-value-button", menuClassName: "settings-dropdown", align: "end" as const };
  return <>
    <div className="settings-option-row">
      <strong>{t("general.appearance")}</strong>
      <QoneSelect {...selector} ariaLabel={t("general.appearance")} value={appearance.theme} onChange={(value) => setThemeSetting(value as ThemeSetting)} options={[
        { value: "system", label: t("general.system") }, { value: "light", label: t("general.light") }, { value: "dark", label: t("general.dark") },
      ]} />
    </div>
    <div className="settings-option-row">
      <strong>{t("general.contrast")}</strong>
      <div className="settings-contrast-control">
        <Slider value={contrast} min={0} max={100} step={1} ariaLabel={t("general.contrast")} onValueChange={(value) => saveModeAppearance(theme, { contrast: value })} />
        <output className="tabular-nums" aria-label={t("general.contrast")}>{contrast}</output>
        <button type="button" className="settings-value-button" disabled={current.contrast === null} onClick={() => saveModeAppearance(theme, { contrast: null })}>{t("general.default")}</button>
      </div>
    </div>
    <div className="settings-option-row">
      <strong>{t("general.accent")}</strong>
      <div className="settings-accent-control">
        {current.accent === "custom" && <>
          <input type="color" aria-label={t("general.custom")} value={current.customAccent} onChange={(event) => saveModeAppearance(theme, { customAccent: event.target.value })} />
          <input type="text" aria-label={t("general.hexColor")} value={hexInput} maxLength={7} spellCheck={false}
            onChange={(event) => { const value = event.target.value; setHexInput(value); if (/^#[\da-f]{6}$/i.test(value)) saveModeAppearance(theme, { customAccent: value }); }}
            onBlur={() => setHexInput(current.customAccent)} />
        </>}
        <QoneSelect {...selector} ariaLabel={t("general.accent")} value={current.accent}
          menuClassName="settings-dropdown settings-accent-menu"
          onChange={(value) => saveModeAppearance(theme, { accent: value as Accent })}
          prefix={<i className="settings-accent-dot" style={{ background: accentPalette(current.accent, theme, current.customAccent).swatch }} />}
          options={ACCENTS.map((accent) => ({
            value: accent,
            label: t(accent === "black" && theme === "dark" ? "general.white" : accentLabels[accent]),
            suffix: <i className="settings-accent-dot" aria-hidden="true" style={{ background: accentPalette(accent, theme, current.customAccent).swatch }} />,
          }))} />
      </div>
    </div>
  </>;
}
