import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { useNavigate } from "@tanstack/react-router";
import { MessageSquare, Play, Plus } from "lucide-react";
import type { ScheduleInfo, ScheduleInput } from "@qone/protocol";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { useLocale } from "../../localization";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { sendScheduleCommand, useScheduleStore } from "../../lib/schedule-state";
import { MorphingSpinner } from "../assistant-ui/morphing-spinner";
import { ScheduleDialog } from "./ScheduleDialog";
import { describeNext, describeRule, describeStatus, formatMoment, scheduleInput } from "./schedule-format";
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
      <button type="button" className="servers-button is-primary" disabled={!hasProject || !connected} onClick={() => setEditing({})}><Plus size={14} />{t("schedules.new")}</button>
    </header>
    {error && !editing && <p className="servers-error">{error}</p>}
    {loaded && !schedules.length && <div className="servers-empty-state">
      <strong>{t("schedules.empty")}</strong>
      <p>{t(hasProject ? "schedules.emptyHint" : "schedules.noProject")}</p>
    </div>}
    <motion.ul layout className="schedule-list">
      <AnimatePresence initial={false}>
        {schedules.map((schedule) => {
          const running = schedule.lastStatus === "running";
          const failed = !running && (schedule.lastStatus === "failed" || schedule.lastStatus === "interrupted" || (!schedule.lastStatus && Boolean(schedule.lastError)));
          const project = workspaces.length > 1 ? workspaces.find((workspace) => workspace.id === schedule.workspaceId)?.name : undefined;
          return <motion.li key={schedule.id} layout initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, scale: .98 }} transition={{ duration: .18 }}
            className={cn("schedule-row", !schedule.enabled && "is-paused")}>
            <button type="button" className="schedule-row-main" onClick={() => setEditing({ schedule })}>
              <strong>{schedule.title}</strong>
              <span className="schedule-row-rule">{describeRule(schedule.rule, t, locale)}<i aria-hidden="true">·</i>{describeNext(schedule, t, locale)}{project && <><i aria-hidden="true">·</i>{project}</>}</span>
              <span className={cn("schedule-row-status", failed && "is-failed", running && "is-running")}>
                {running && <MorphingSpinner className="size-3" />}{describeStatus(schedule, t, locale)}
              </span>
            </button>
            <div className="schedule-row-actions">
              {schedule.sessionId && <button type="button" className="servers-icon-button" title={t("schedules.openChat")} aria-label={t("schedules.openChat")} onClick={() => openChat(schedule.sessionId!)}><MessageSquare size={15} /></button>}
              <button type="button" className="servers-icon-button" title={t("schedules.runNow")} aria-label={t("schedules.runNow")} disabled={running || !connected} onClick={() => runNow(schedule)}><Play size={15} /></button>
              <button type="button" role="switch" aria-checked={schedule.enabled} aria-label={t(schedule.enabled ? "schedules.disable" : "schedules.enable")}
                className={cn("settings-switch", schedule.enabled && "is-on")} disabled={!connected}
                onClick={() => void save({ ...scheduleInput(schedule), enabled: !schedule.enabled })}><span /></button>
            </div>
          </motion.li>;
        })}
      </AnimatePresence>
    </motion.ul>
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
                <MessageSquare size={14} aria-hidden="true" />
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
