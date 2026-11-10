import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { check } from "../../lib/desktop-bridge";
import { localizeError } from "../../lib/error-localization";
import { saveLanguageSetting, useLocale, type LanguageSetting, type LocalizedMessage } from "../../localization";
import { AppearanceOptions } from "./AppearanceOptions";
import { SectionHeader, SettingsPageHeader, SettingsSelect } from "./settings-chrome";

export function GeneralSection() {
  const { t, languageSetting } = useLocale();
  const [updateStatus, setUpdateStatus] = useState<LocalizedMessage | null>(null);
  const [checking, setChecking] = useState(false);

  const checkForUpdates = async () => {
    setChecking(true);
    setUpdateStatus({ key: "general.checking" });
    try {
      const update = await check({ timeout: 10_000 });
      if (!update) {
        setUpdateStatus({ key: "general.latest" });
        return;
      }
      setUpdateStatus({ key: "general.foundUpdate", values: { version: update.version } });
      await update.downloadAndInstall();
      setUpdateStatus({ key: "general.installed" });
    } catch (error) {
      setUpdateStatus({ key: "general.updateFailed", values: { error: localizeError(error) } });
    } finally {
      setChecking(false);
    }
  };

  return (
    <>
      <SettingsPageHeader><SectionHeader eyebrow={t("general.eyebrow")} title={t("general.title")}>{t("general.description")}</SectionHeader></SettingsPageHeader>
      <div className="settings-general-options">
        <AppearanceOptions />
        <div className="settings-option-row">
          <strong>{t("general.language")}</strong>
          <SettingsSelect value={languageSetting} onChange={(value) => saveLanguageSetting(value as LanguageSetting)} options={[{ value: "auto", label: t("general.auto") }, { value: "zh-CN", label: t("general.chinese") }, { value: "en", label: "English" }]} />
        </div>
      </div>
      <div className="settings-preference-row">
        <div><strong>{t("general.updates")}</strong><span>{t("general.updateDescription")}</span></div>
        <button className="settings-secondary-action" type="button" disabled={checking} onClick={checkForUpdates}>
          {checking && <LoaderCircle size={14} className="settings-spin" />}
          {checking ? t("general.checking") : t("general.checkForUpdates")}
        </button>
      </div>
      {updateStatus && <p className="settings-inline-status" role="status">{t(updateStatus.key, updateStatus.values)}</p>}
    </>
  );
}