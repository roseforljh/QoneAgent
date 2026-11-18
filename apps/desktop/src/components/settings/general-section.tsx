import { useState } from "react";
import { LoaderCircle } from "lucide-react";
import { check, type UpdateResult } from "../../lib/desktop-bridge";
import { confirmAction } from "../../lib/confirm-action";
import { localizeError } from "../../lib/error-localization";
import { saveLanguageSetting, useLocale, type LanguageSetting, type LocalizedMessage } from "../../localization";
import { AppearanceOptions } from "./AppearanceOptions";
import { SectionHeader, SettingsPageHeader, SettingsSelect } from "./settings-chrome";

type UpdatePhase = { kind: "idle" } | { kind: "checking" } | { kind: "downloading"; percent: number } | { kind: "ready"; update: UpdateResult };

export function GeneralSection() {
  const { t, languageSetting } = useLocale();
  const [updateStatus, setUpdateStatus] = useState<LocalizedMessage | null>(null);
  const [phase, setPhase] = useState<UpdatePhase>({ kind: "idle" });

  const offerRestart = async (update: UpdateResult) => {
    const now = await confirmAction({
      title: t("general.updateReadyTitle"),
      message: t("general.updateReadyMessage", { version: update.version }),
      confirmLabel: t("general.restartNow"),
      cancelLabel: t("general.later"),
      destructive: false,
    });
    setPhase({ kind: "ready", update });
    setUpdateStatus(null);
    try {
      await update.install(now);
      if (!now) setUpdateStatus({ key: "general.installOnQuit", values: { version: update.version } });
    } catch (error) {
      setUpdateStatus({ key: "general.installFailed", values: { error: localizeError(error) } });
    }
  };

  const runUpdate = async () => {
    try {
      if (phase.kind === "ready") return await offerRestart(phase.update);
      setPhase({ kind: "checking" });
      setUpdateStatus(null);
      const update = await check({ timeout: 10_000 });
      if (!update) {
        setPhase({ kind: "idle" });
        setUpdateStatus({ key: "general.latest" });
        return;
      }
      setPhase({ kind: "downloading", percent: 0 });
      setUpdateStatus({ key: "general.foundUpdate", values: { version: update.version } });
      if (await update.download((percent) => setPhase({ kind: "downloading", percent })) === "external") {
        setPhase({ kind: "idle" });
        setUpdateStatus({ key: "general.releasePageOpened" });
        return;
      }
      await offerRestart(update);
    } catch (error) {
      setPhase({ kind: "idle" });
      setUpdateStatus({ key: "general.updateFailed", values: { error: localizeError(error) } });
    }
  };

  const busy = phase.kind === "checking" || phase.kind === "downloading";
  const label = phase.kind === "checking" ? t("general.checking")
    : phase.kind === "downloading" ? t("general.downloading", { percent: phase.percent })
      : phase.kind === "ready" ? t("general.restartToUpdate") : t("general.checkForUpdates");

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
        <button className="settings-secondary-action" type="button" disabled={busy} onClick={runUpdate}>
          {busy && <LoaderCircle size={14} className="settings-spin" />}
          {label}
        </button>
      </div>
      {updateStatus && <p className="settings-inline-status" role="status">{t(updateStatus.key, updateStatus.values)}</p>}
    </>
  );
}
