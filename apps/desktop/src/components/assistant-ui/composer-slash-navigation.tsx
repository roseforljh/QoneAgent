import { useEffect } from "react";
import { ComposerPrimitive, unstable_useTriggerPopoverScopeContext } from "@assistant-ui/react";
import { ArrowLeft } from "lucide-react";
import { useLocale } from "../../localization";
import type { SkillGroup } from "../../lib/skill-groups";
import type { ComposerSlashEntry } from "./composer-tools";

export function ComposerSlashNavigation({ groups, entries }: { groups: SkillGroup[]; entries: ComposerSlashEntry[] }) {
  const { t } = useLocale();
  const scope = unstable_useTriggerPopoverScopeContext();
  const { open, activeCategoryId, selectItem, goBack } = scope;
  const directEntry = entries.find((entry) => entry.id === activeCategoryId);
  const group = groups.find((item) => item.id === activeCategoryId);
  useEffect(() => {
    if (!open || !activeCategoryId) return;
    // Single commands still execute immediately; only packages require a second selection.
    if (directEntry) selectItem({ id: directEntry.id, type: "command", label: directEntry.label });
    else if (!group) goBack();
  }, [open, activeCategoryId, directEntry, group, selectItem, goBack]);
  return <ComposerPrimitive.Unstable_TriggerPopoverBack className="q-composer-slash-back" aria-label={t("skills.package.back")} onMouseDown={(event) => event.preventDefault()}>
    <ArrowLeft size={14} /><span>{group?.name ?? t("skills.package.back")}</span>
  </ComposerPrimitive.Unstable_TriggerPopoverBack>;
}
