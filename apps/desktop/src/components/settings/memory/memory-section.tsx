import { useEffect, useMemo, useState } from "react";
import { Tabs } from "radix-ui";
import { motion } from "motion/react";
import { LoaderCircle } from "lucide-react";
import { useStore } from "../../../store";
import { cn } from "../../../lib/utils";
import { sendMemoryCommand, useMemoryStore } from "../../../lib/memory-state";
import { useLocale } from "../../../localization";
import { SectionHeader, SettingsPageHeader } from "../settings-chrome";
import { MemoryNotes, MemoryOverview, MemorySummaries, SummaryDialog } from "./memory-panels";
import "./memory.css";

type Tab = "overview" | "summaries" | "notes";

export function MemorySection() {
  const { t, locale } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const { state, pending, error } = useMemoryStore();
  const [tab, setTab] = useState<Tab>("overview");
  const [openSummary, setOpenSummary] = useState<string>();
  const run = (command: Parameters<typeof sendMemoryCommand>[0]) => sendMemoryCommand(command, send);
  useEffect(() => { if (connected) void run({ type: "memory.get" }); }, [connected]);
  const time = useMemo(() => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }), [locale]);
  const relative = (at: number) => {
    if (!at) return t("memory.never");
    const minutes = Math.round((at - Date.now()) / 60_000);
    if (Math.abs(minutes) < 60) return time.format(minutes, "minute");
    if (Math.abs(minutes) < 1_440) return time.format(Math.round(minutes / 60), "hour");
    return time.format(Math.round(minutes / 1_440), "day");
  };

  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "overview", label: t("memory.overview") },
    { id: "summaries", label: t("memory.conversations"), count: state?.summaries.length },
    { id: "notes", label: t("memory.notes"), count: state?.notes.length },
  ];

  return (
    <>
      <SettingsPageHeader>
        <div className="memory-header">
          <SectionHeader eyebrow={t("memory.eyebrow")} title={t("memory.title")}>{t("memory.useDescription")}</SectionHeader>
          <label className="memory-toggle">
            <span>{state?.enabled ? t("memory.on") : t("memory.off")}</span>
            <button type="button" role="switch" aria-label={t("memory.use")} aria-checked={Boolean(state?.enabled)} disabled={!state || pending > 0}
              className={cn("settings-switch", state?.enabled && "is-on")} onClick={() => state && void run({ type: "memory.enabled.set", enabled: !state.enabled })}><span /></button>
          </label>
        </div>
      </SettingsPageHeader>
      {error && <p className="memory-error">{error}</p>}
      {!state ? <div className="memory-loading"><LoaderCircle className="animate-spin" size={18} /></div> : (
        <div className={cn("memory-page", !state.enabled && "is-off")}>
          <div className="memory-stats">
            <Stat label={t("memory.statUpdated")} value={relative(state.stats.lastUpdatedAt)} />
            <Stat label={t("memory.statConversations")} value={String(state.summaries.length)} />
            <Stat label={t("memory.statCalls")} value={state.stats.calls.toLocaleString(locale)} />
            <Stat label={t("memory.statTokens")} value={Intl.NumberFormat(locale, { notation: "compact" }).format(state.stats.tokens)} />
          </div>
          <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)} className="memory-tabs">
            <Tabs.List className="memory-tab-list" aria-label={t("memory.title")}>
              {tabs.map((item) => (
                <Tabs.Trigger key={item.id} value={item.id} className="memory-tab">
                  {item.label}{item.count !== undefined && <span className="memory-tab-count">{item.count}</span>}
                  {tab === item.id && <motion.span layoutId="memory-tab-indicator" className="memory-tab-indicator" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value="overview" className="memory-tab-panel">
              <MemoryOverview state={state} relative={relative} onOpenSummary={setOpenSummary} />
            </Tabs.Content>
            <Tabs.Content value="summaries" className="memory-tab-panel">
              <MemorySummaries summaries={state.summaries} relative={relative} onOpen={setOpenSummary}
                onDelete={(id) => void run({ type: "memory.summary.delete", id })} />
            </Tabs.Content>
            <Tabs.Content value="notes" className="memory-tab-panel">
              <MemoryNotes notes={state.notes} relative={relative} busy={pending > 0}
                onSave={(content, id) => run({ type: "memory.note.save", id, content })}
                onDelete={(id) => run({ type: "memory.note.delete", id })} />
            </Tabs.Content>
          </Tabs.Root>
          <p className="memory-footnote">{t("memory.privacy")}</p>
        </div>
      )}
      <SummaryDialog summary={state?.summaries.find((item) => item.id === openSummary)} relative={relative}
        onOpenChange={(open) => { if (!open) setOpenSummary(undefined); }}
        onDelete={async (id) => { if (await run({ type: "memory.summary.delete", id })) setOpenSummary(undefined); }} />
    </>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return <div className="memory-stat"><span>{label}</span><strong>{value}</strong></div>;
}
