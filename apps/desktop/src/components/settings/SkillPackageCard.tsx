import { Dialog } from "radix-ui";
import { ChevronRight, X } from "lucide-react";
import { useLocale } from "../../localization";
import { skillGroupRepresentative, type SkillGroup } from "../../lib/skill-groups";
import { SkillIcon } from "../skills/SkillIcon";
import { SkillCard } from "./SkillCard";
import "./skills.css";

export function SkillPackageCard({ group }: { group: SkillGroup }) {
  const { t } = useLocale();
  const representative = skillGroupRepresentative(group);
  return <Dialog.Root>
    <Dialog.Trigger asChild>
      <button type="button" className="settings-skill-card settings-skill-package" data-skill-package={group.id}>
        <span className="settings-provider-icon"><SkillIcon skill={representative} className="size-6" /></span>
        <div><strong>{group.name} <span className="settings-skill-package-badge">{t("skills.builtin")}</span></strong><small>{representative.description}</small><small>{representative.source} · {t("skills.package.count", { count: group.skills.length })}</small></div>
        <ChevronRight size={16} />
      </button>
    </Dialog.Trigger>
    <Dialog.Portal>
      <Dialog.Overlay className="settings-skill-package-overlay" />
      <Dialog.Content className="settings-skill-package-dialog" onEscapeKeyDown={(event) => event.stopPropagation()}>
        <div className="settings-skill-package-header">
          <SkillIcon skill={representative} className="size-8" />
          <div><Dialog.Title>{group.name}</Dialog.Title><Dialog.Description>{t("skills.package.description", { count: group.skills.length })}</Dialog.Description></div>
          <Dialog.Close className="settings-dialog-close" aria-label={t("common.close")}><X size={17} /></Dialog.Close>
        </div>
        <div className="settings-skill-package-members">{group.skills.map((skill) => <SkillCard key={skill.id} skill={skill} />)}</div>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
