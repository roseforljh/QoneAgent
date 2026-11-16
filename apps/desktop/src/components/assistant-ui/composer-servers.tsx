import { useState } from "react";
import { Check, X } from "lucide-react";
import { useConversationStore } from "../../lib/conversation-context";
import { useServerStore } from "../../lib/server-state";
import { useLocale } from "../../localization";
import { NestedDialog } from "../settings/nested-dialog";
import { CodexServerIcon } from "../ui/CodexIcon";

export function ComposerServers({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLocale();
  const servers = useServerStore(state => state.servers);
  const options = useConversationStore(state => state.currentSessionId ? state.runOptionsBySession[state.currentSessionId] : state.draftRunOptions);
  const setServerIds = useConversationStore(state => state.setServerIds);
  const ids = options?.serverIds ?? [];
  const [search, setSearch] = useState("");
  const toggle = (id: string) => setServerIds(ids.includes(id) ? ids.filter(value => value !== id) : [...ids, id]);
  const visible = servers.filter(server => `${server.name} ${server.host} ${server.username}`.toLowerCase().includes(search.toLowerCase()));
  return <>
    {ids.length > 0 && <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/10 px-2 text-sky-700 transition-colors dark:text-sky-300">
      <button type="button" onClick={() => onOpenChange(true)} className="inline-flex items-center gap-1.5 text-xs font-medium" title={servers.filter(server => ids.includes(server.id)).map(server => server.name).join("、")}>
        <CodexServerIcon className="size-3.5" /><span>{t("servers.title")}</span>{ids.length > 1 && <span className="rounded-full bg-sky-500/15 px-1.5 text-[10px] tabular-nums">{ids.length}</span>}
      </button>
      <button type="button" onClick={() => setServerIds([])} className="ml-0.5 rounded-full p-0.5 opacity-65 hover:opacity-100" aria-label={t("composer.removeServer", { name: t("servers.title") })}><X size={12} /></button>
    </span>}
    <NestedDialog open={open} onOpenChange={onOpenChange} title={t("servers.title")} description={t("composer.toolServersDescription")}
      footer={<button type="button" className="servers-button is-primary" onClick={() => onOpenChange(false)}>{t("composer.serversDone")}</button>}>
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
  </>;
}
