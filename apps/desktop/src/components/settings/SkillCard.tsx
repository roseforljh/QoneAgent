import { useRef, useState } from "react";
import { Switch } from "@base-ui/react/switch";
import { openPath, openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, LoaderCircle } from "lucide-react";
import type { SkillInfo } from "@qone/protocol";
import { requestSkillMutation } from "../../store";
import { localizeError } from "../../lib/error-localization";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { SkillIcon } from "../skills/SkillIcon";
import "./skills.css";

export function SkillCard({ skill, disabled = false }: { skill: SkillInfo; disabled?: boolean }) {
  const { t } = useLocale();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const inFlight = useRef(false);
  const open = async () => {
    try { await openPath(skill.path); } catch (cause) { setError(localizeError(cause)); }
  };
  const change = async (enabled: boolean) => {
    if (inFlight.current || disabled) return;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      await requestSkillMutation({ type: "skills.builtin.set-enabled", skillId: skill.id, enabled });
    } catch (cause) {
      setError(localizeError(cause));
    } finally {
      inFlight.current = false;
      setBusy(false);
    }
  };

  return <div className="settings-skill-entry">
    {skill.builtin ? <article className={cn("settings-skill-card settings-builtin-skill", skill.enabled === false && "is-disabled")}>
      <span className="settings-provider-icon"><SkillIcon skill={skill} className="size-6" /></span>
      <div className="settings-builtin-skill-copy">
        <div className="settings-builtin-skill-title"><button type="button" onClick={() => void open()}>{skill.name}</button><span title={t("skills.builtin.protected")}>{t("skills.builtin")}</span></div>
        <small>{skill.description}</small>
        <small><button type="button" onClick={() => void openUrl(`https://github.com/${skill.source}`).catch((cause) => setError(localizeError(cause)))}>{skill.source}</button> · <code title={skill.revision}>{skill.revision?.slice(0, 7)}</code></small>
      </div>
      <span className="settings-builtin-skill-actions">
        <Switch.Root checked={skill.enabled !== false} disabled={busy || disabled} aria-busy={busy} aria-label={t("skills.builtin.enabled", { name: skill.name })} className={cn("settings-switch", skill.enabled !== false && "is-on")} onCheckedChange={(enabled) => void change(enabled)}>{busy ? <LoaderCircle className="settings-spin" size={13} /> : <Switch.Thumb />}</Switch.Root>
      </span>
    </article> : <button type="button" className="settings-skill-card" onClick={() => void open()}><span className="settings-provider-icon"><SkillIcon skill={skill} className="size-4" /></span><div><strong>{skill.name}</strong><small>{skill.path}</small></div><ChevronRight size={15} /></button>}
    {error && <p className="settings-skill-error" role="alert">{error}</p>}
  </div>;
}
