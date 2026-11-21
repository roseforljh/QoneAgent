import { useEffect, useMemo, useState } from "react";
import { Tabs } from "radix-ui";
import { motion } from "motion/react";
import { LoaderCircle } from "lucide-react";
import { MEMORY_AUTOMATIC_PREFERENCES_PER_SCOPE } from "@qone/protocol";
import { useStore } from "../../../store";
import { cn } from "../../../lib/utils";
import { sendMemoryCommand, useMemoryStore } from "../../../lib/memory-state";
import { useLocale } from "../../../localization";
import { SectionHeader, SettingsPageHeader } from "../settings-chrome";
import { MemoryAutomaticPreferences, MemoryNotes, MemoryOverview, MemorySummaries, SummaryDialog } from "./memory-panels";
import { MemoryModelSetting } from "./memory-model-setting";
import "./memory.css";

type Tab = "preferences" | "summaries" | "notes" | "overview";

export function MemorySection({ onOpenExecution, onResumed }: { onOpenExecution: () => void; onResumed: () => void }) {
  const { t, locale } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const { state, pending, error } = useMemoryStore();
  const workspaces = useStore((state) => state.workspaces);
  const workspaceId = useStore((state) => state.currentWorkspaceId);
  const creatingSession = useStore((state) => state.creatingSession);
  const createSession = useStore((state) => state.createSessionForWorkspace);
  const [tab, setTab] = useState<Tab>("preferences");
  const [openSummary, setOpenSummary] = useState<string>();
  const run = (command: Parameters<typeof sendMemoryCommand>[0]) => sendMemoryCommand(command, send);
  useEffect(() => { if (connected) void run({ type: "memory.get" }); }, [connected]);
  const time = useMemo(() => new Intl.RelativeTimeFormat(locale, { numeric: "auto" }), [locale]);
  const relative = (at: number) => {
    const minutes = Math.round((at - Date.now()) / 60_000);
    if (Math.abs(minutes) < 60) return time.format(minutes, "minute");
    if (Math.abs(minutes) < 1_440) return time.format(Math.round(minutes / 60), "hour");
    return time.format(Math.round(minutes / 1_440), "day");
  };

  const preferences = state?.notes.filter((note) => note.preference) ?? [];
  const automatic = state?.automaticPreferences ?? [];
  const notes = state?.notes.filter((note) => !note.preference) ?? [];
  const summary = state?.summaries.find((item) => item.id === openSummary);
  const summaryWorkspace = workspaces.find((workspace) => workspace.id === summary?.workspaceId);
  const busy = !connected || pending > 0;
  const noteActions: Pick<Parameters<typeof MemoryNotes>[0], "onSave" | "onDelete"> = {
    onSave: (content, id, preference) => run({ type: "memory.note.save", id, content, preference }),
    onDelete: (id) => run({ type: "memory.note.delete", id }),
  };
  const tabs: { id: Tab; label: string; count?: number }[] = [
    { id: "preferences", label: t("memory.preferences"), count: preferences.length + automatic.length },
    { id: "summaries", label: t("memory.conversations"), count: state?.summaries.length },
    { id: "notes", label: t("memory.notes"), count: notes.length },
    { id: "overview", label: t("memory.overview") },
  ];

  return (
    <>
      <SettingsPageHeader>
        <div className="memory-header">
          <SectionHeader eyebrow={t("memory.eyebrow")} title={t("memory.title")}>{t("memory.useDescription")}</SectionHeader>
          <label className="memory-toggle">
            <span>{state?.enabled ? t("memory.on") : t("memory.off")}</span>
            <button type="button" role="switch" aria-label={t("memory.use")} aria-checked={Boolean(state?.enabled)} disabled={!state || busy}
              className={cn("settings-switch", state?.enabled && "is-on")} onClick={() => state && void run({ type: "memory.enabled.set", enabled: !state.enabled })}><span /></button>
          </label>
        </div>
      </SettingsPageHeader>
      {error && <p className="memory-error" role="alert">{error}</p>}
      {!state ? <div className="memory-loading"><LoaderCircle className="animate-spin" size={18} /></div> : (
        <div className="memory-page">
          <MemoryModelSetting modelId={state.modelId} disabled={busy}
            onChange={(modelId) => void run({ type: "memory.model.set", modelId })} />
          {!state.enabled && <p className="memory-hint">{t("memory.paused")}</p>}
          <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)} className="memory-tabs">
            <Tabs.List className="memory-tab-list" aria-label={t("memory.title")}>
              {tabs.map((item) => (
                <Tabs.Trigger key={item.id} value={item.id} className="memory-tab">
                  {item.label}{item.count !== undefined && <span className="memory-tab-count">{item.count}</span>}
                  {tab === item.id && <motion.span layoutId="memory-tab-indicator" className="memory-tab-indicator" transition={{ type: "spring", stiffness: 520, damping: 40 }} />}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
            <Tabs.Content value="preferences" className="memory-tab-panel">
              <p className="memory-hint">{t("memory.preferencesDescription", { limit: String(MEMORY_AUTOMATIC_PREFERENCES_PER_SCOPE) })}</p>
              <MemoryAutomaticPreferences preferences={automatic} summaries={state.summaries} workspaces={workspaces} busy={busy}
                onEdit={(id, value) => run({ type: "memory.preference.edit", id, value })} onOpenSummary={setOpenSummary} />
              <MemoryNotes preferences notes={preferences} relative={relative} busy={busy} workspaces={workspaces}
                workspaceId={workspaces.find((workspace) => workspace.id === workspaceId)?.id} {...noteActions} />
            </Tabs.Content>
            <Tabs.Content value="summaries" className="memory-tab-panel">
              <p className="memory-hint">{t("memory.summariesDescription")}</p>
              <MemorySummaries summaries={state.summaries} relative={relative} onOpen={setOpenSummary}
                onDelete={(id) => void run({ type: "memory.summary.delete", id })} />
            </Tabs.Content>
            <Tabs.Content value="notes" className="memory-tab-panel">
              <p className="memory-hint">{t("memory.notesDescription")}</p>
              <MemoryNotes notes={notes} relative={relative} busy={busy} workspaces={workspaces} {...noteActions} />
            </Tabs.Content>
            <Tabs.Content value="overview" className="memory-tab-panel">
              <p className="memory-hint">{t("memory.overviewDescription")}</p>
              <MemoryOverview state={state} relative={relative} onOpenSummary={setOpenSummary} />
            </Tabs.Content>
          </Tabs.Root>
          <div className="memory-execution">
            <p className="memory-hint">{t("memory.executionDescription")}</p>
            <button type="button" className="memory-button" onClick={onOpenExecution}>{t("nav.execution")}</button>
          </div>
          <p className="memory-footnote">{t("memory.privacy")}</p>
        </div>
      )}
      <SummaryDialog summary={summary} relative={relative} workspace={summaryWorkspace} canResume={Boolean(state?.enabled) && !busy && !creatingSession}
        onResume={async (item, workspace) => {
          if (await createSession(workspace.id, { id: item.id, title: item.title })) onResumed();
        }}
        onOpenChange={(open) => { if (!open) setOpenSummary(undefined); }}
        onDelete={async (id) => { if (await run({ type: "memory.summary.delete", id })) setOpenSummary(undefined); }} />
    </>
  );
}
