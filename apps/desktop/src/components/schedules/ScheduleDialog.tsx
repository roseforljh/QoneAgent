import { useEffect, useMemo, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { RunThinkingLevel, ScheduleInfo, ScheduleInput, ScheduleRule } from "@qone/protocol";
import { NestedDialog } from "../settings/nested-dialog";
import { QoneSelect } from "../ui/Select";
import { ModelPicker } from "../assistant-ui/model-picker";
import { cn } from "../../lib/utils";
import { useLocale, type MessageKey } from "../../localization";
import { useStore } from "../../store";
import { DEFAULT_RUN_PERMISSION_MODE, withRunOptionDefaults } from "../../lib/run-options";
import { useScheduleStore } from "../../lib/schedule-state";
import { toLocalInput, WEEK_ORDER } from "./schedule-format";
import { TimePicker } from "./TimePicker";
import "../settings/servers/servers.css";

type Kind = ScheduleRule["kind"];
type Unit = "minutes" | "hours";
const KINDS: Kind[] = ["daily", "weekly", "interval", "once"];

/** Run options of the bound conversation, or of the one open now when the task gets its own. */
function sessionRunOptions(sessionId: string) {
  const state = useStore.getState();
  const id = sessionId || state.currentSessionId;
  const options = withRunOptionDefaults(id ? state.runOptionsBySession[id] : undefined, state.draftRunOptions);
  return { ...options, modelId: options.modelId ?? state.selectedModelId };
}

/** The one task page: creates a task, or edits `schedule` when given. */
export function ScheduleDialog({ open, schedule, onOpenChange, onSave, onDelete, onRun }: {
  open: boolean; schedule?: ScheduleInfo; onOpenChange: (open: boolean) => void;
  onSave: (input: ScheduleInput) => Promise<boolean>; onDelete: (schedule: ScheduleInfo) => void; onRun: (schedule: ScheduleInfo) => void;
}) {
  const { t } = useLocale();
  const workspaces = useStore((state) => state.workspaces);
  const sessions = useStore((state) => state.sessions);
  const error = useScheduleStore((state) => state.error);
  const [title, setTitle] = useState("");
  const [prompt, setPrompt] = useState("");
  const [workspaceId, setWorkspaceId] = useState("");
  /** "" lets the task create its own conversation on the first run. */
  const [sessionId, setSessionId] = useState("");
  const [model, setModel] = useState("");
  const [thinkingByModel, setThinkingByModel] = useState<Record<string, RunThinkingLevel>>({});
  const [kind, setKind] = useState<Kind>("daily");
  const [time, setTime] = useState("09:00");
  const [days, setDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [at, setAt] = useState("");
  const [every, setEvery] = useState("1");
  const [unit, setUnit] = useState<Unit>("hours");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    const rule = schedule?.rule;
    setTitle(schedule?.title ?? "");
    setPrompt(schedule?.prompt ?? "");
    const state = useStore.getState();
    setWorkspaceId(schedule?.workspaceId ?? state.currentWorkspaceId ?? state.workspaces[0]?.id ?? "");
    setSessionId(schedule?.sessionId ?? "");
    const options = sessionRunOptions(schedule?.sessionId ?? "");
    setModel(schedule?.model ?? options.modelId ?? "");
    setThinkingByModel({ ...options.thinkingByModel, ...(schedule?.model && schedule.thinking ? { [schedule.model]: schedule.thinking } : {}) });
    setKind(rule?.kind ?? "daily");
    setTime(rule?.kind === "daily" || rule?.kind === "weekly" ? rule.time : "09:00");
    setDays(rule?.kind === "weekly" ? rule.days : [1, 2, 3, 4, 5]);
    setAt(toLocalInput(rule?.kind === "once" ? rule.at : Date.now() + 3_600_000));
    const hours = rule?.kind === "interval" && rule.minutes % 60 === 0;
    setUnit(rule?.kind === "interval" && !hours ? "minutes" : "hours");
    setEvery(rule?.kind === "interval" ? String(hours ? rule.minutes / 60 : rule.minutes) : "1");
    useScheduleStore.setState({ error: undefined });
  }, [open, schedule]);

  const minutes = Number(every) * (unit === "hours" ? 60 : 1);
  const onceAt = at ? new Date(at).getTime() : NaN;
  const rule: ScheduleRule | undefined = kind === "daily" ? { kind, time }
    : kind === "weekly" ? (days.length ? { kind, days, time } : undefined)
    : kind === "interval" ? (Number.isInteger(minutes) && minutes >= 5 ? { kind, minutes } : undefined)
    : onceAt > Date.now() ? { kind, at: onceAt } : undefined;
  const sessionOptions = useMemo(() => [{ value: "", label: t("schedules.sessionNew") }, ...sessions
    .filter((session) => session.workspaceId === workspaceId && !session.sideChat)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((session) => ({ value: session.id, label: session.title }))], [sessions, workspaceId, t]);
  const pickWorkspace = (id: string) => { setWorkspaceId(id); setSessionId(""); };
  const pickSession = (id: string) => {
    const options = sessionRunOptions(id);
    setSessionId(id);
    setModel(options.modelId ?? "");
    setThinkingByModel(options.thinkingByModel ?? {});
  };
  const valid = Boolean(title.trim() && prompt.trim() && workspaceId && rule && (kind === "once" || /^\d{2}:\d{2}$/.test(time) || kind === "interval"));

  const submit = async () => {
    if (!valid || busy || !rule) return;
    setBusy(true);
    const ok = await onSave({ id: schedule?.id, title: title.trim(), prompt: prompt.trim(), workspaceId, sessionId: sessionId || undefined, rule, enabled: schedule?.enabled ?? true,
      model: model || undefined, thinking: model ? thinkingByModel[model] : undefined,
      permissionMode: sessionRunOptions(sessionId).permissionMode ?? DEFAULT_RUN_PERMISSION_MODE });
    setBusy(false);
    if (ok) onOpenChange(false);
  };
  const toggleDay = (day: number) => setDays((current) => current.includes(day) ? current.filter((value) => value !== day) : [...current, day]);

  return (
    <NestedDialog open={open} onOpenChange={(next) => { if (!busy) onOpenChange(next); }} wide
      title={t(schedule ? "schedules.edit" : "schedules.new")} description={t("schedules.runHint")}
      footer={<>
        <ModelPicker control={{
          modelId: model, thinkingByModel, setModel,
          setThinking: (id, level) => setThinkingByModel((current) => ({ ...current, [id]: level })),
        }} />
        <span className="server-dialog-spacer" />
        {schedule && <>
          <button type="button" className="servers-button is-danger" disabled={busy} onClick={() => onDelete(schedule)}>{t("schedules.delete")}</button>
          <button type="button" className="servers-button" disabled={busy || schedule.lastStatus === "running"} onClick={() => onRun(schedule)}>{t("schedules.runNow")}</button>
        </>}
        <button type="button" className="servers-button is-primary" disabled={!valid || busy} onClick={() => void submit()}>
          {busy && <LoaderCircle className="animate-spin" size={14} />}{t(schedule ? "schedules.save" : "schedules.create")}
        </button>
      </>}>
      <form className="servers-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label className="servers-field"><span>{t("schedules.name")}</span>
          <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("schedules.namePlaceholder")} maxLength={80} autoFocus disabled={busy} />
        </label>
        <div className="servers-field-row">
          {workspaces.length > 1 && <div className="servers-field is-grow"><span>{t("schedules.project")}</span>
            <QoneSelect value={workspaceId} onChange={pickWorkspace} options={workspaces.map((workspace) => ({ value: workspace.id, label: workspace.name }))}
              ariaLabel={t("schedules.project")} className="servers-select" triggerClassName="servers-select-trigger" disabled={busy} />
          </div>}
          <div className="servers-field is-grow"><span>{t("schedules.session")}</span>
            <QoneSelect value={sessionId} onChange={pickSession} options={sessionOptions}
              ariaLabel={t("schedules.session")} className="servers-select" triggerClassName="servers-select-trigger" disabled={busy} />
          </div>
        </div>
        <label className="servers-field"><span>{t("schedules.prompt")}</span>
          <textarea className="schedule-prompt" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder={t("schedules.promptPlaceholder")} rows={5} disabled={busy} />
        </label>
        <div className="servers-field"><span>{t("schedules.repeat")}</span>
          <div className="servers-segment" role="radiogroup" aria-label={t("schedules.repeat")}>
            {KINDS.map((value) => <button key={value} type="button" role="radio" aria-checked={kind === value} disabled={busy}
              className={cn(kind === value && "is-active")} onClick={() => setKind(value)}>{t(`schedules.rule.${value}` as MessageKey)}</button>)}
          </div>
        </div>
        {kind === "weekly" && <div className="servers-field"><span>{t("schedules.days")}</span>
          <div className="schedule-days">
            {WEEK_ORDER.map((day) => <button key={day} type="button" aria-pressed={days.includes(day)} disabled={busy}
              className={cn(days.includes(day) && "is-active")} onClick={() => toggleDay(day)}>{t(`schedules.weekday.${day}` as MessageKey)}</button>)}
          </div>
        </div>}
        {(kind === "daily" || kind === "weekly") && <div className="servers-field"><span>{t("schedules.time")}</span>
          <TimePicker value={time} onChange={setTime} disabled={busy} ariaLabel={t("schedules.time")} />
        </div>}
        {kind === "interval" && <div className="servers-field"><span>{t("schedules.every")}</span>
          <div className="schedule-interval">
            <input value={every} onChange={(event) => setEvery(event.target.value.replace(/\D/g, ""))} inputMode="numeric" disabled={busy} aria-label={t("schedules.every")} />
            <div className="servers-segment" role="radiogroup" aria-label={t("schedules.every")}>
              {(["minutes", "hours"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={unit === value} disabled={busy}
                className={cn(unit === value && "is-active")} onClick={() => setUnit(value)}>{t(`schedules.unit.${value}`)}</button>)}
            </div>
          </div>
        </div>}
        {kind === "once" && <label className="servers-field schedule-time"><span>{t("schedules.when")}</span>
          <input type="datetime-local" value={at} onChange={(event) => setAt(event.target.value)} disabled={busy} />
        </label>}
        {error && !busy && <p className="servers-error">{error}</p>}
        <button type="submit" hidden />
      </form>
    </NestedDialog>
  );
}
