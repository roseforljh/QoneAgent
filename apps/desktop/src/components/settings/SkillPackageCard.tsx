import { Dialog } from "radix-ui";
import { Switch } from "@base-ui/react/switch";
import { ChevronRight, LoaderCircle, X } from "lucide-react";
import { useRef, useState } from "react";
import { useLocale } from "../../localization";
import { skillGroupRepresentative, type SkillGroup } from "../../lib/skill-groups";
import { localizeError } from "../../lib/error-localization";
import { requestSkillMutation } from "../../store";
import { cn } from "../../lib/utils";
import { SkillIcon } from "../skills/SkillIcon";
import { SkillCard } from "./SkillCard";
import "./skills.css";

export function SkillPackageCard({ group }: { group: SkillGroup }) {
  const { t } = useLocale();
  const representative = skillGroupRepresentative(group);
  const [busy, setBusy] = useState<"toggle" | "update" | null>(null);
  const [error, setError] = useState("");
  const [status, setStatus] = useState("");
  const inFlight = useRef(false);
  const enabled = group.skills.some((skill) => skill.enabled !== false);
  const partial = enabled && group.skills.some((skill) => skill.enabled === false);
  const change = async (action: "toggle" | "update", nextEnabled?: boolean) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(action);
    setError("");
    setStatus("");
    try {
      const results = await Promise.allSettled(group.skills.map((skill) => requestSkillMutation(action === "update"
        ? { type: "skills.builtin.update", skillId: skill.id }
        : { type: "skills.builtin.set-enabled", skillId: skill.id, enabled: nextEnabled! })));
      const failures = results.flatMap((result, index) => result.status === "rejected"
        ? [`${group.skills[index]!.name}: ${localizeError(result.reason)}`] : []);
      if (failures.length) {
        setError(failures.join("\n"));
      } else if (action === "update") {
        const updated = results.some((result) => result.status === "fulfilled" && result.value.type === "skills.builtin.changed" && result.value.updated);
        setStatus(t(updated ? "skills.builtin.updated" : "skills.builtin.current"));
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  };

  return <Dialog.Root>
    <div className="settings-skill-entry">
      <article className={cn("settings-skill-card settings-skill-package", !enabled && "is-disabled")} aria-busy={busy !== null}>
        <Dialog.Trigger asChild>
          <button type="button" className="settings-skill-package-main" data-skill-package={group.id}>
            <span className="settings-provider-icon"><SkillIcon skill={representative} className="size-6" /></span>
            <div><strong>{group.name} <span className="settings-skill-package-badge">{t("skills.builtin")}</span></strong><small>{representative.description}</small><small>{representative.source} · {t("skills.package.count", { count: group.skills.length })}{partial && ` · ${t("skills.package.partial")}`}</small></div>
            <ChevronRight size={16} />
          </button>
        </Dialog.Trigger>
        <span className="settings-builtin-skill-actions">
          <button type="button" className="settings-secondary-action" disabled={busy !== null} onClick={() => void change("update")}>
            {busy === "update" && <LoaderCircle className="settings-spin" size={14} />}
            {t(busy === "update" ? "skills.builtin.updating" : "skills.builtin.update")}
          </button>
          <Switch.Root checked={enabled} disabled={busy !== null} aria-busy={busy !== null} aria-label={t("skills.package.enabled", { name: group.name })} className={cn("settings-switch", enabled && "is-on")} onCheckedChange={(checked) => void change("toggle", checked)}>{busy === "toggle" ? <LoaderCircle className="settings-spin" size={13} /> : <Switch.Thumb />}</Switch.Root>
        </span>
      </article>
      {status && <p className="settings-builtin-skill-status" role="status">{status}</p>}
      {error && <p className="settings-skill-error settings-skill-package-error" role="alert">{error}</p>}
    </div>
    <Dialog.Portal>
      <Dialog.Overlay className="settings-skill-package-overlay" />
      <Dialog.Content className="settings-skill-package-dialog" onEscapeKeyDown={(event) => event.stopPropagation()}>
        <div className="settings-skill-package-header">
          <SkillIcon skill={representative} className="size-8" />
          <div><Dialog.Title>{group.name}</Dialog.Title><Dialog.Description>{t("skills.package.description", { count: group.skills.length })}</Dialog.Description></div>
          <Dialog.Close className="settings-dialog-close" aria-label={t("common.close")}><X size={17} /></Dialog.Close>
        </div>
        <div className="settings-skill-package-members">{group.skills.map((skill) => <SkillCard key={skill.id} skill={skill} disabled={busy !== null} />)}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
