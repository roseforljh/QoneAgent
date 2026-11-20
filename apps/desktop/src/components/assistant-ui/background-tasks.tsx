import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { shallow } from "zustand/shallow";
import { useStore, type AgentState } from "../../store";
import { useLocale } from "../../localization";
import { openBackgroundJob } from "../../lib/background-job-links";
import { cn } from "../../lib/utils";
import { CodexIcon } from "../ui/CodexIcon";
import tasksIcon from "../../assets/codex-icons/tasks-light-20.svg";
import { field, fieldInteractive, paper } from "./elements/surfaces";
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

export function BackgroundTasks({ renderHeader, children }: { renderHeader: (toggle: ReactNode) => ReactNode; children: ReactNode }) {
  const sessionId = useStore((state) => state.currentSessionId);
  const { t } = useLocale();
  const selectTasks = useMemo(() => createTaskSelector(sessionId), [sessionId]);
  const tasks = useStore(selectTasks);
  const [openSessionId, setOpenSessionId] = useState<string>();
  const previous = useRef<{ sessionId?: string; viewedSince: number; statuses: Map<string, boolean> }>(undefined);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const open = Boolean(sessionId && sessionId === openSessionId && tasks.length);
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
    if (hasNewTask) setOpenSessionId(sessionId);
    else if (!last || !tasks.length) setOpenSessionId(undefined);
  }, [tasks, sessionId]);

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
      aria-expanded={open} aria-controls={panelId} data-state={open ? "open" : "closed"}
      onClick={() => setOpenSessionId(open ? undefined : sessionId)}>
      <CodexIcon src={tasksIcon} className="size-[18px]" />
      {tasks.some((task) => task.active) && <span aria-hidden="true" className="absolute end-1 top-1 size-1.5 rounded-full bg-blue-500 ring-2 ring-background" />}
    </TooltipIconButton> : null)}
    <div className="q-chat-body relative flex min-h-0 flex-1 flex-col">
      {sessionId && tasks.length > 0 && <aside key={sessionId} ref={panelRef} id={panelId} aria-label={title} inert={!open}
        data-open={open ? "" : undefined} className="q-background-tasks"
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.stopPropagation();
          close();
        }}>
        <div className="min-h-0 overflow-hidden">
          <div className={cn(paper, "my-2 rounded-lg p-1")}>
            <div className="px-1.5 py-1 text-[11px] font-medium text-muted-foreground">{title}</div>
            <ul className="grid max-h-[min(11rem,24dvh)] gap-1 overflow-y-auto overscroll-contain">
              {tasks.map((task) => <li key={taskKey(task)} className="min-w-0">
                <button type="button" title={task.name}
                  className={cn(fieldInteractive, "flex min-h-6 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-1.5 py-0.5 text-start text-xs focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring")}
                  onClick={() => {
                    close();
                    (task.kind === "subagent" ? openSubagent : openBackgroundJob)(task.id, sessionId);
                  }}>
                  <span className={cn(field, "shrink-0 rounded px-0.5 text-[10px] leading-4 text-muted-foreground")}>{t(task.kind === "subagent" ? "nav.subagents" : "backgroundTasks.command")}</span>
                  <span className={cn("min-w-0 flex-1 truncate", task.kind === "command" && "font-mono")}>{task.name}</span>
                  {task.active && <><span className="sr-only">{t("backgroundTasks.active")}</span><span aria-hidden="true" className="size-1 shrink-0 rounded-full bg-blue-500" /></>}
                </button>
              </li>)}
            </ul>
          </div>
        </div>
      </aside>}
      {children}
    </div>
  </>;
}
