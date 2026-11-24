import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { shallow } from "zustand/shallow";
import { useStore, type AgentState } from "../../store";
import { useLocale } from "../../localization";
import { openBackgroundJob } from "../../lib/background-job-links";
import { CLOSE_DOCK_PANEL_EVENT } from "../../lib/dock-state";
import { cn } from "../../lib/utils";
import { CodexIcon } from "../ui/CodexIcon";
import tasksIcon from "../../assets/codex-icons/tasks-light-20.svg";
import { CodexChevronRightIcon } from "./execution-icons";
import { field } from "./elements/surfaces";
import { isActiveSubagent } from "../../lib/subagent-state";
import { openSubagent } from "./subagent-navigation";
import { TooltipIconButton } from "./tooltip-icon-button";

type Task = { kind: "subagent" | "command"; id: string; name: string; active: boolean; startedAt: number };
const taskKey = (task: Task) => `${task.kind}:${task.id}`;

function createTaskSelector(sessionId: string | undefined) {
  let source: Pick<AgentState, "subagents" | "backgroundJobs"> | undefined;
  let rows: Task[] = [];
  return ({ subagents, backgroundJobs }: AgentState): readonly Task[] => {
    if (!sessionId || (source?.subagents === subagents && source.backgroundJobs === backgroundJobs)) return rows;
    source = { subagents, backgroundJobs };
    const next: Task[] = [];
    for (const agent of subagents) {
      if (agent.parentSessionId !== sessionId) continue;
      next.push({ kind: "subagent", id: agent.id, name: agent.title, active: isActiveSubagent(agent.status), startedAt: agent.startedAt });
    }
    for (const job of backgroundJobs) {
      if (job.sessionId !== sessionId) continue;
      next.push({ kind: "command", id: job.id, name: job.command, active: job.status === "running", startedAt: job.startedAt });
    }
    next.sort((a, b) => Number(b.active) - Number(a.active) || b.startedAt - a.startedAt);
    // Streaming transcripts and process output are not part of the card.
    if (next.length !== rows.length || next.some((row, i) => !shallow(row, rows[i]))) rows = next;
    return rows;
  };
}

export function BackgroundTasks({ dockOpen, renderHeader, children }: { dockOpen: boolean; renderHeader: (toggle: ReactNode) => ReactNode; children: ReactNode }) {
  const sessionId = useStore((state) => state.currentSessionId);
  const { t } = useLocale();
  const selectTasks = useMemo(() => createTaskSelector(sessionId), [sessionId]);
  const tasks = useStore(selectTasks);
  const [openSessionId, setOpenSessionId] = useState<string>();
  const previous = useRef<{ sessionId?: string; viewedSince: number; statuses: Map<string, boolean> }>(undefined);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const open = !dockOpen && Boolean(sessionId && sessionId === openSessionId && tasks.length);
  useEffect(() => {
    if (dockOpen) setOpenSessionId(undefined);
  }, [dockOpen]);
  useEffect(() => {
    const last = previous.current?.sessionId === sessionId ? previous.current : undefined;
    const viewedSince = last?.viewedSince ?? Date.now();
    const statuses = new Map<string, boolean>();
    let hasNewTask = false;
    for (const task of tasks) {
      const key = taskKey(task);
      const wasActive = last?.statuses.get(key);
      // A short task may already be finished by the time both updates render.
      if ((task.active && !wasActive) || (last && wasActive === undefined && task.startedAt >= viewedSince)) hasNewTask = true;
      statuses.set(key, task.active);
    }
    previous.current = { sessionId, viewedSince, statuses };
    if (hasNewTask && !dockOpen) setOpenSessionId(sessionId);
    else if (!last || !tasks.length) setOpenSessionId(undefined);
  }, [tasks, sessionId, dockOpen]);

  useEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!open || !panel || !trigger) return;
    const document = panel.ownerDocument;
    const dismiss = (event: MouseEvent) => {
      const path = event.composedPath();
      if (!path.includes(panel) && !path.includes(trigger)) setOpenSessionId(undefined);
    };
    document.addEventListener("click", dismiss, true);
    return () => document.removeEventListener("click", dismiss, true);
  }, [open, sessionId]);

  const title = t("backgroundTasks.title");
  const close = () => {
    setOpenSessionId(undefined);
    triggerRef.current?.focus({ preventScroll: true });
  };
  return <>
    {renderHeader(tasks.length ? <TooltipIconButton ref={triggerRef} tooltip={title} className="q-thread-header-action relative"
      aria-expanded={open} aria-controls={dockOpen ? undefined : panelId} data-state={open ? "open" : "closed"}
      onClick={() => {
        if (dockOpen) window.dispatchEvent(new Event(CLOSE_DOCK_PANEL_EVENT));
        setOpenSessionId(open ? undefined : sessionId);
      }}>
      <CodexIcon src={tasksIcon} className="size-[18px]" />
      {tasks.some((task) => task.active) && <span aria-hidden="true" className="absolute end-1 top-1 size-1.5 rounded-full bg-blue-500 ring-2 ring-background" />}
    </TooltipIconButton> : null)}
    <div className="q-chat-body relative flex min-h-0 flex-1 flex-col">
      {!dockOpen && sessionId && tasks.length > 0 && <aside key={sessionId} ref={panelRef} id={panelId} aria-label={title} inert={!open}
        data-open={open ? "" : undefined} className="q-background-tasks"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close();
        }}>
        <div className="q-background-tasks-card">
          <div className="q-background-tasks-head">
            <span className="text-xs font-medium text-foreground/90">{title}</span>
            <span className="q-background-tasks-count" aria-hidden="true">{tasks.length}</span>
          </div>
          <ul className="q-background-tasks-list">
            {tasks.map((task) => <li key={taskKey(task)} className="min-w-0">
              <button type="button" title={task.name} className="q-background-tasks-row group"
                onClick={() => {
                  close();
                  (task.kind === "subagent" ? openSubagent : openBackgroundJob)(task.id, sessionId);
                }}>
                <span aria-hidden="true" data-active={task.active ? "" : undefined} className="q-background-tasks-dot" />
                {task.active && <span className="sr-only">{t("backgroundTasks.active")}</span>}
                <span className={cn(field, "shrink-0 rounded px-1.5 py-0.5 text-[10.5px] leading-none text-muted-foreground")}>{t(task.kind === "subagent" ? "nav.subagents" : "backgroundTasks.command")}</span>
                <span className={cn("min-w-0 flex-1 truncate", task.kind === "command" && "font-mono text-[11.5px]")}>{task.name}</span>
                <CodexChevronRightIcon size={12} aria-hidden="true" className="shrink-0 text-muted-foreground/45 transition-[color,transform] duration-150 group-hover:translate-x-0.5 group-hover:text-foreground/75 motion-reduce:transition-none" />
              </button>
            </li>)}
          </ul>
        </div>
      </aside>}
      {children}
    </div>
  </>;
}
