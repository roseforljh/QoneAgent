import { useEffect, useState } from "react";
import { Switch } from "@base-ui/react/switch";
import { confirmAction } from "../../lib/confirm-action";
import { invoke, isDesktop } from "../../lib/desktop-bridge";
import { localizeError } from "../../lib/error-localization";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";

interface AdministratorLaunch { enabled: boolean; elevated: boolean }

export function AdministratorLaunchOption() {
  const { t } = useLocale();
  const [state, setState] = useState<AdministratorLaunch | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDesktop()) return;
    let active = true;
    void invoke<AdministratorLaunch | null>("administrator_launch_get").then((value) => {
      if (active) setState(value);
    }).catch((error) => { if (active) setError(localizeError(error)); });
    return () => { active = false; };
  }, []);

  const toggle = async (enabled: boolean) => {
    setPending(true);
    setError(null);
    try {
      if (enabled && !await confirmAction({
        title: t("general.administratorLaunch"),
        message: t("general.administratorConfirm"),
        confirmLabel: t("general.administratorEnable"),
        destructive: false,
      })) return;
      await invoke("administrator_launch_set", { enabled });
      setState((current) => current && { ...current, enabled });
    } catch (error) {
      setError(localizeError(error));
    } finally {
      setPending(false);
    }
  };

  return <>
    {state && <div className="settings-preference-row">
      <div>
        <strong>{t("general.administratorLaunch")}</strong>
        <span>{t(state.elevated ? "general.administratorActive" : "general.administratorDescription")}</span>
      </div>
      <Switch.Root
        checked={state.enabled}
        disabled={pending}
        aria-label={t("general.administratorLaunch")}
        className={cn("settings-switch", state.enabled && "is-on")}
        onCheckedChange={toggle}
      ><Switch.Thumb /></Switch.Root>
    </div>}
    {error && <p className="settings-inline-status" role="alert">{t("general.administratorFailed", { error })}</p>}
  </>;
}
