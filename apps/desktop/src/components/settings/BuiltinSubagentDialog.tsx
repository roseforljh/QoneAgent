import { useMemo, useState } from "react";
import { ArrowLeft, Search } from "lucide-react";
import { ECC_BUILTIN_SUBAGENTS, type BuiltinSubagentCatalogEntry, type SubagentProfileInfo } from "@qone/protocol";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { SubagentLogo } from "./subagent-logo";

export function BuiltinSubagentSettings({
  profiles,
  onToggle,
  onBack,
  backLabel,
}: {
  profiles: readonly SubagentProfileInfo[];
  onToggle: (entry: BuiltinSubagentCatalogEntry, enabled: boolean) => void;
  onBack: () => void;
  backLabel: string;
}) {
  const { t } = useLocale();
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
          return <article className={cn("settings-builtin-subagent-entry", profile && !enabled && "is-disabled")} key={entry.id}>
            <SubagentLogo logo={profile?.logo} name={entry.name} size={34} />
            <div className="settings-builtin-subagent-copy"><strong>{entry.name}</strong></div>
            {profile ? <button type="button" role="switch" aria-checked={enabled} aria-label={t(enabled ? "subagent.disable" : "subagent.enable")} className={cn("settings-switch", enabled && "is-on")} onClick={() => onToggle(entry, !enabled)}><span /></button> : <button type="button" className="settings-secondary-action" onClick={() => onToggle(entry, true)}>{t("subagent.addBuiltIn")}</button>}
          </article>;
        })}
        {visible.length === 0 && <p className="settings-empty">{t("subagent.noBuiltIns")}</p>}
      </div>
    </section>;
}
