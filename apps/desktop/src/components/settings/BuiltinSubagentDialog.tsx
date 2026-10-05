import { useMemo, useState, type KeyboardEvent } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { ECC_BUILTIN_SUBAGENTS, type BuiltinSubagentCatalogEntry, type SubagentProfileInfo } from "@qone/protocol";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { subagentProfileCopy } from "../../lib/subagent-profile-copy";
import { SubagentLogo } from "./subagent-logo";

export function BuiltinSubagentSettings({
  profiles,
  onToggle,
  onEdit,
  onBack,
  backLabel,
}: {
  profiles: readonly SubagentProfileInfo[];
  onToggle: (entry: BuiltinSubagentCatalogEntry, enabled: boolean) => void;
  onEdit?: (entry: BuiltinSubagentCatalogEntry, profile?: SubagentProfileInfo) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const { t, locale } = useLocale();
  const [query, setQuery] = useState("");
  const installed = useMemo(() => new Map(profiles.map((profile) => [profile.id, profile])), [profiles]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    if (!normalized) return ECC_BUILTIN_SUBAGENTS;
    return ECC_BUILTIN_SUBAGENTS.filter((entry) => `${entry.name} ${entry.description}`.toLowerCase().includes(normalized));
  }, [query]);
  return <section className="settings-builtin-subagent-settings" aria-label={t("subagent.builtInCatalog")}>
      <div className="settings-page-header">
        <button type="button" className="settings-subagent-back" onClick={onBack}>
          <ArrowLeft size={14} aria-hidden="true" />
          {backLabel}
        </button>
        <label className="settings-builtin-subagent-search"><Search size={15} aria-hidden="true" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("subagent.searchBuiltIns")} aria-label={t("subagent.searchBuiltIns")} /></label>
      </div>
      <div className="settings-builtin-subagent-list">
        {visible.map((entry) => {
          const profile = installed.get(entry.id);
          const enabled = profile?.enabled === true;
          const display = subagentProfileCopy(profile ?? entry, locale);
          const openEditor = () => onEdit?.(entry, profile);
          return <article className={cn("settings-builtin-subagent-entry", onEdit && "is-actionable", profile && !enabled && "is-disabled")} key={entry.id}
            {...(onEdit ? { role: "button" as const, tabIndex: 0, "aria-label": `${display.name} · ${t("common.edit")}`, onClick: openEditor, onKeyDown: (event: KeyboardEvent<HTMLElement>) => { if (event.key === "Enter" || event.key === " ") { event.preventDefault(); openEditor(); } } } : {})}>
            <SubagentLogo logo={profile?.logo} name={display.name} size={34} />
            <div className="settings-builtin-subagent-copy"><strong>{display.name}</strong><small>{entry.name}</small></div>
            <button type="button" role="switch" aria-checked={enabled} aria-label={t(enabled ? "subagent.disable" : "subagent.enable")} className={cn("settings-switch", enabled && "is-on")} onClick={(event) => { event.stopPropagation(); onToggle(entry, !enabled); }}><span /></button>
          </article>;
        })}
        {visible.length === 0 && <p className="settings-empty">{t("subagent.noBuiltIns")}</p>}
      </div>
    </section>;
}
