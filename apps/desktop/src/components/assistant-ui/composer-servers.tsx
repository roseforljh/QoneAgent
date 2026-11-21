import { X } from "lucide-react";
import { useConversationStore } from "../../lib/conversation-context";
import { useServerStore } from "../../lib/server-state";
import { useLocale } from "../../localization";
import { CodexServerIcon } from "../ui/CodexIcon";
import { ServerPickerDialog } from "./server-picker-dialog";

export function ComposerServers({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { t } = useLocale();
  const servers = useServerStore(state => state.servers);
  const options = useConversationStore(state => state.currentSessionId ? state.runOptionsBySession[state.currentSessionId] : state.draftRunOptions);
  const setServerIds = useConversationStore(state => state.setServerIds);
  const ids = options?.serverIds ?? [];
  return <>
    {ids.length > 0 && <span className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-sky-500/25 bg-sky-500/10 px-2 text-sky-700 transition-colors dark:text-sky-300">
      <button type="button" onClick={() => onOpenChange(true)} className="inline-flex items-center gap-1.5 text-xs font-medium" title={servers.filter(server => ids.includes(server.id)).map(server => server.name).join("、")}>
        <CodexServerIcon className="size-3.5" /><span>{t("servers.title")}</span>{ids.length > 1 && <span className="rounded-full bg-sky-500/15 px-1.5 text-[10px] tabular-nums">{ids.length}</span>}
      </button>
      <button type="button" onClick={() => setServerIds([])} className="ml-0.5 rounded-full p-0.5 opacity-65 hover:opacity-100" aria-label={t("composer.removeServer", { name: t("servers.title") })}><X size={12} /></button>
    </span>}
    <ServerPickerDialog open={open} onOpenChange={onOpenChange} title={t("servers.title")} description={t("composer.toolServersDescription")}
      ids={ids} onChange={setServerIds} />
  </>;
}
