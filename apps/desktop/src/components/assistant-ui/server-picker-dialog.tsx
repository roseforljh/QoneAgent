import { useState } from "react";
import { Check } from "lucide-react";
import { useServerStore } from "../../lib/server-state";
import { useLocale } from "../../localization";
import { NestedDialog } from "../settings/nested-dialog";
import { CodexServerIcon } from "../ui/CodexIcon";

export function ServerPickerDialog({ open, onOpenChange, title, description, ids, onChange, onSave }: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description: string;
  ids: readonly string[];
  onChange: (ids: string[]) => void;
  onSave?: () => void;
}) {
  const { t } = useLocale();
  const servers = useServerStore(state => state.servers);
  const loaded = useServerStore(state => state.loaded);
  const [search, setSearch] = useState("");
  const toggle = (id: string) => onChange(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  const query = search.toLowerCase();
  const visible = servers.filter(server => `${server.name} ${server.host} ${server.username}`.toLowerCase().includes(query));
  return (
    <NestedDialog open={open} onOpenChange={onOpenChange} title={title} description={description}
      footer={<button type="button" className="servers-button is-primary" disabled={Boolean(onSave) && !loaded}
        onClick={() => { onSave?.(); onOpenChange(false); }}>{t(onSave ? "common.save" : "composer.serversDone")}</button>}>
      <input className="w-full rounded-lg border border-border bg-transparent px-3 py-2 text-sm outline-none focus:border-ring" value={search} onChange={event => setSearch(event.target.value)} placeholder={t("composer.searchServers")} aria-label={t("composer.searchServers")} />
      <div className="mt-2 flex max-h-80 flex-col gap-1 overflow-y-auto" role="group" aria-label={t("servers.title")}>
        {visible.map(server => <button key={server.id} type="button" role="checkbox" aria-checked={ids.includes(server.id)} onClick={() => toggle(server.id)} className="flex items-center gap-3 rounded-lg p-3 text-left hover:bg-foreground/5">
          <CodexServerIcon className="size-4 shrink-0" />
          <span className="min-w-0 flex-1"><strong className="block truncate text-sm font-medium">{server.name}</strong><small className="block truncate text-muted-foreground">{server.username}@{server.host} · {t(`servers.status.${server.status}`)}</small></span>
          {ids.includes(server.id) && <Check size={16} />}
        </button>)}
        {!visible.length && <p className="p-3 text-sm text-muted-foreground">{t("composer.noServers")}</p>}
        {!servers.length && <button type="button" className="servers-button" onClick={() => { onOpenChange(false); window.dispatchEvent(new Event("qone-open-settings")); }}>{t("accessibility.settings")}</button>}
      </div>
    </NestedDialog>
  );
}
