import type { ReactNode } from "react";
import { QoneSelect } from "../ui/Select";
import { useLocale } from "../../localization";

export function SectionHeader({ eyebrow, title, children }: { eyebrow: string; title: string; children?: ReactNode }) {
  return (
    <div className="settings-dialog-heading">
      <span>{eyebrow}</span>
      <h2>{title}</h2>
      {children && <p>{children}</p>}
    </div>
  );
}

export function SettingsPageHeader({ children }: { children: ReactNode }) {
  return <div className="settings-page-header">{children}</div>;
}

export type SettingsChoice = { value: string; label: string; description?: string };

export function SettingsSelect({ value, options, onChange, prefix }: { value: string; options: SettingsChoice[]; onChange: (value: string) => void; prefix?: ReactNode }) {
  const { t } = useLocale();
  return <QoneSelect value={value} options={options} onChange={onChange} prefix={prefix} className="settings-select-wrap" triggerClassName="settings-value-button" menuClassName="settings-dropdown" align="end" ariaLabel={t("accessibility.option")} />;
}