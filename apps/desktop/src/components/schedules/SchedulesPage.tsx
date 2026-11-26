import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "@tanstack/react-router";
import type { ScheduleInfo, ScheduleInput } from "@qone/protocol";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { sendScheduleCommand, useScheduleStore } from "../../lib/schedule-state";
import { MorphingSpinner } from "../assistant-ui/morphing-spinner";
import { TooltipProvider } from "../ui/tooltip";
import { CodexIcon, CodexPlusIcon } from "../ui/CodexIcon";
import chatIcon from "../../assets/codex-icons/chat-bubble-light-16.svg";
import { ScheduleCard } from "./ScheduleCard";
import { ScheduleDialog } from "./ScheduleDialog";
import { formatMoment, scheduleInput } from "./schedule-format";
import "./schedules.css";

export function SchedulesPage() {
  const { t, locale } = useLocale();
  const navigate = useNavigate();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const hasProject = useStore((state) => state.workspaces.length > 0);
  const workspaces = useStore((state) => state.workspaces);
  const { schedules, runs, loaded, error } = useScheduleStore();
  const [editing, setEditing] = useState<{ schedule?: ScheduleInfo }>();
  const run = (command: Parameters<typeof sendScheduleCommand>[0]) => sendScheduleCommand(command, send);
  useEffect(() => { if (connected) void run({ type: "schedule.list" }); }, [connected]);

  const save = (schedule: ScheduleInput) => run({ type: "schedule.save", schedule });
  const remove = async (schedule: ScheduleInfo) => {
    if (!await confirmDestructiveAction(t("schedules.deleteConfirm", { title: schedule.title }))) return;
    if (await run({ type: "schedule.delete", id: schedule.id })) setEditing(undefined);
  };
  const runNow = (schedule: ScheduleInfo) => void run({ type: "schedule.run", id: schedule.id });
  const openChat = (sessionId: string) => void navigate({ to: "/chat/$sessionId", params: { sessionId } });
  // Opening the editor refers to the live copy, so status changes show while it is open.
  const current = editing?.schedule && schedules.find((item) => item.id === editing.schedule!.id);

  return <div className="schedules-page">
    <header className="schedules-header">
      <div><h1>{t("schedules.title")}</h1><p>{t("schedules.description")}</p></div>
      <button type="button" className="servers-button is-primary" disabled={!hasProject || !connected} onClick={() => setEditing({})}><CodexPlusIcon className="size-3.5" />{t("schedules.new")}</button>
    </header>
    {error && !editing && <p className="servers-error">{error}</p>}
    {loaded && !schedules.length && <div className="servers-empty-state">
      <strong>{t("schedules.empty")}</strong>
      <p>{t(hasProject ? "schedules.emptyHint" : "schedules.noProject")}</p>
    </div>}
    {schedules.length > 0 && <TooltipProvider delayDuration={300}>
      <motion.ul layout className="schedule-board">
        <AnimatePresence initial={false}>
          {schedules.map((schedule) => {
            const project = workspaces.length > 1 ? workspaces.find((workspace) => workspace.id === schedule.workspaceId)?.name : undefined;
            return (
              <ScheduleCard
                key={schedule.id}
                schedule={schedule}
                project={project}
                connected={connected}
                onEdit={(item) => setEditing({ schedule: item })}
                onToggle={(item, enabled) => void save({ ...scheduleInput(item), enabled })}
                onRunNow={runNow}
                onOpenChat={openChat}
              />
            );
          })}
        </AnimatePresence>
      </motion.ul>
    </TooltipProvider>}
    {runs.length > 0 && <section className="schedule-history">
      <h2>{t("schedules.history")}</h2>
      <ul>
        <AnimatePresence initial={false}>
          {runs.map((entry) => {
            const title = schedules.find((item) => item.id === entry.scheduleId)?.title;
            return <motion.li key={entry.id} layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }} transition={{ duration: .16 }}>
              <button type="button" className="schedule-history-row" onClick={() => openChat(entry.sessionId)} title={entry.error}>
                <span className={cn("schedule-history-status", `is-${entry.status}`)}>
                  {entry.status === "running" ? <MorphingSpinner className="size-3" /> : <i aria-hidden="true" />}{t(`schedules.run.${entry.status}`)}
                </span>
                <strong>{title}</strong>
                <time>{formatMoment(entry.startedAt, locale)}</time>
                <CodexIcon src={chatIcon} className="size-3.5" />
              </button>
            </motion.li>;
          })}
        </AnimatePresence>
      </ul>
    </section>}
    <ScheduleDialog open={Boolean(editing)} schedule={current} onOpenChange={(open) => { if (!open) setEditing(undefined); }}
      onSave={save} onDelete={(schedule) => void remove(schedule)} onRun={runNow} />
  </div>;
}
