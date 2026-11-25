import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { shallow } from "zustand/shallow";
import tasksIcon from "../../assets/codex-icons/tasks-light-20.svg";
import { useStore, type AgentState, type ToolCall } from "../../store";
import { useLocale } from "../../localization";
import { backgroundJobLink, openBackgroundJob } from "../../lib/background-job-links";
import { browserUrlFromTool, formatBrowserTarget, isBuiltInBrowserTool, openBuiltInBrowserTask } from "../../lib/browser-navigation";
import { useBrowserTasks, type AgentBrowserTask } from "../../lib/browser-tasks";
import { CLOSE_DOCK_PANEL_EVENT } from "../../lib/dock-state";
import { cn } from "../../lib/utils";
import { CodexIcon } from "../ui/CodexIcon";
import { CodexBrowserIcon, CodexChevronRightIcon, CodexRobotIcon, CodexTerminalIcon } from "./execution-icons";
import { isActiveSubagent } from "../../lib/subagent-state";
import { openSubagent } from "./subagent-navigation";
import { TooltipIconButton } from "./tooltip-icon-button";

type Task = {
  kind: "subagent" | "command" | "browser";
  id: string;
  name: string;
  title: string;
  url?: string;
  liveBrowser?: boolean;
  active: boolean;
  startedAt: number;
};

type HistoryBrowserRecord = {
  id: string;
  url?: string;
  active: boolean;
  startedAt: number;
};

const taskKey = (task: Task) => `${task.kind}:${task.id}`;
const MODIFIER_KEYS = new Set(["Shift", "Control", "Alt", "Meta"]);

function normalizeBrowserUrlKey(url: string | undefined): string | undefined {
  const raw = url?.trim();
  if (!raw) return undefined;
  try {
    const parsed = new URL(raw);
    const pathname = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${pathname}${parsed.search}`;
  } catch {
    return raw.replace(/\/+$/, "").toLowerCase();
  }
}

function extractHistoryBrowserRecords(toolCalls: readonly ToolCall[]): HistoryBrowserRecord[] {
  const byUrl = new Map<string, HistoryBrowserRecord>();
  let fallback: HistoryBrowserRecord | undefined;
  for (const call of toolCalls) {
    if (call.sourceSubagentId || !isBuiltInBrowserTool(call.toolName)) continue;
    const url = browserUrlFromTool(call.args, call.result);
    const active = call.status === "running" || call.status === "waiting";
    const startedAt = call.startedAt ?? call.completedAt ?? 0;
    const norm = normalizeBrowserUrlKey(url);
    if (norm && url) {
      const existing = byUrl.get(norm);
      byUrl.set(norm, {
        id: existing?.id ?? `history:${norm}`,
        url,
        active: active || Boolean(existing?.active),
        startedAt: Math.max(existing?.startedAt ?? 0, startedAt),
      });
      continue;
    }
    // 无 URL 的后续读取/交互步骤不单独拆分卡片项，仅在整场会话从未记录 URL 时保留兜底项。
    if (!fallback) {
      fallback = { id: `history:${call.toolCallId}`, active, startedAt };
    } else {
      fallback = { ...fallback, active: fallback.active || active, startedAt: Math.max(fallback.startedAt, startedAt) };
    }
  }
  if (byUrl.size > 0) return [...byUrl.values()];
  return fallback ? [fallback] : [];
}

function createStoreTaskSelector(sessionId: string | undefined) {
  let source: Pick<AgentState, "subagents" | "backgroundJobs" | "toolCalls"> | undefined;
  let cached: { baseTasks: readonly Task[]; historyBrowsers: readonly HistoryBrowserRecord[] } = {
    baseTasks: [],
    historyBrowsers: [],
  };
  return ({ subagents, backgroundJobs, toolCalls }: AgentState) => {
    if (!sessionId) return cached;
    if (source?.subagents === subagents && source.backgroundJobs === backgroundJobs && source.toolCalls === toolCalls) {
      return cached;
    }
    source = { subagents, backgroundJobs, toolCalls };
    const next: Task[] = [];
    for (const agent of subagents) {
      if (agent.parentSessionId !== sessionId) continue;
      next.push({
        kind: "subagent",
        id: agent.id,
        name: agent.title,
        title: agent.title,
        active: isActiveSubagent(agent.status),
        startedAt: agent.startedAt,
      });
    }
    const seenJobIds = new Set<string>();
    for (const job of backgroundJobs) {
      if (job.sessionId !== sessionId) continue;
      seenJobIds.add(job.id);
      next.push({
        kind: "command",
        id: job.id,
        name: job.command,
        title: job.command,
        active: job.status === "running",
        startedAt: job.startedAt,
      });
    }
    // 从持久化 toolCalls 兜底还原历史后台命令，避免应用重启或热重载后命令卡片丢失。
    for (const call of toolCalls) {
      if (call.sourceSubagentId) continue;
      const link = backgroundJobLink(call.args, call.result);
      if (!link || seenJobIds.has(link.id)) continue;
      seenJobIds.add(link.id);
      next.push({
        kind: "command",
        id: link.id,
        name: link.command,
        title: link.command,
        active: call.status === "running" || call.status === "waiting",
        startedAt: call.startedAt ?? call.completedAt ?? 0,
      });
    }
    next.sort((a, b) => Number(b.active) - Number(a.active) || b.startedAt - a.startedAt);
    const historyBrowsers = extractHistoryBrowserRecords(toolCalls);
    const sameBase = next.length === cached.baseTasks.length && next.some((row, i) => !shallow(row, cached.baseTasks[i])) === false;
    const sameHistory = historyBrowsers.length === cached.historyBrowsers.length
      && historyBrowsers.some((row, i) => !shallow(row, cached.historyBrowsers[i])) === false;
    if (!sameBase || !sameHistory) {
      cached = {
        baseTasks: sameBase ? cached.baseTasks : next,
        historyBrowsers: sameHistory ? cached.historyBrowsers : historyBrowsers,
      };
    }
    return cached;
  };
}

function mergeSessionTasks(
  baseTasks: readonly Task[],
  browserTasks: readonly AgentBrowserTask[],
  historyBrowsers: readonly HistoryBrowserRecord[],
  sessionId: string | undefined,
  browserFallback: string,
): readonly Task[] {
  if (!sessionId) return [];
  const next: Task[] = [...baseTasks];
  const liveUrlKeys = new Set<string>();
  let hasLiveBrowser = false;
  for (const item of browserTasks) {
    if (item.sessionId !== sessionId) continue;
    hasLiveBrowser = true;
    const norm = normalizeBrowserUrlKey(item.url);
    if (norm) liveUrlKeys.add(norm);
    next.push({
      kind: "browser",
      id: item.id,
      name: formatBrowserTarget(item.url, browserFallback),
      title: item.url || browserFallback,
      url: item.url,
      liveBrowser: true,
      active: item.active,
      startedAt: item.startedAt,
    });
  }
  // 合并会话持久化 toolCalls 中的内置浏览器记录，优先保留实时托管任务并按 URL 去重。
  for (const record of historyBrowsers) {
    const norm = normalizeBrowserUrlKey(record.url);
    if (norm && liveUrlKeys.has(norm)) continue;
    if (!norm && hasLiveBrowser) continue;
    next.push({
      kind: "browser",
      id: record.id,
      name: formatBrowserTarget(record.url, browserFallback),
      title: record.url || browserFallback,
      url: record.url,
      liveBrowser: false,
      active: record.active,
      startedAt: record.startedAt,
    });
  }
  next.sort((a, b) => Number(b.active) - Number(a.active) || b.startedAt - a.startedAt);
  return next;
}

export function BackgroundTasks({ dockOpen, renderHeader, children }: { dockOpen: boolean; renderHeader: (toggle: ReactNode) => ReactNode; children: ReactNode }) {
  const sessionId = useStore((state) => state.currentSessionId);
  const { t } = useLocale();
  const selectStoreTasks = useMemo(() => createStoreTaskSelector(sessionId), [sessionId]);
  const { baseTasks, historyBrowsers } = useStore(selectStoreTasks);
  const browserTasks = useBrowserTasks((state) => state.tasks);
  const browserFallback = t("browser.title");
  const tasks = useMemo(
    () => mergeSessionTasks(baseTasks, browserTasks, historyBrowsers, sessionId, browserFallback),
    [baseTasks, browserTasks, historyBrowsers, sessionId, browserFallback],
  );
  const [openSessionId, setOpenSessionId] = useState<string>();
  const [unseenSessionId, setUnseenSessionId] = useState<string>();
  const previous = useRef<{ sessionId?: string; viewedSince: number; statuses: Map<string, boolean> }>(undefined);
  const openRef = useRef(false);
  const panelId = useId();
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const activeCount = tasks.reduce((count, task) => count + (task.active ? 1 : 0), 0);
  const hasActive = activeCount > 0;
  const open = !dockOpen && Boolean(sessionId && sessionId === openSessionId && tasks.length > 0);
  const showIndicator = !open && Boolean(sessionId && (unseenSessionId === sessionId || hasActive));
  openRef.current = open;

  useEffect(() => {
    if (dockOpen) setOpenSessionId(undefined);
  }, [dockOpen]);

  // 新任务产生或重新激活时，仅在右上角按钮显示小点提示，绝不自动弹出悬浮卡片。
  useEffect(() => {
    const last = previous.current?.sessionId === sessionId ? previous.current : undefined;
    const viewedSince = last?.viewedSince ?? Date.now();
    const statuses = new Map<string, boolean>();
    let hasNewTask = false;
    for (const task of tasks) {
      const key = taskKey(task);
      const wasActive = last?.statuses.get(key);
      if ((task.active && !wasActive) || (last && wasActive === undefined && task.startedAt >= viewedSince)) hasNewTask = true;
      statuses.set(key, task.active);
    }
    previous.current = { sessionId, viewedSince, statuses };
    if (hasNewTask && sessionId && !openRef.current) setUnseenSessionId(sessionId);
    if (!last || !tasks.length) {
      setOpenSessionId(undefined);
      if (!tasks.length) setUnseenSessionId((current) => (current === sessionId ? undefined : current));
    }
  }, [tasks, sessionId]);

  // 悬浮卡片展开后，任何外部点击、滚轮滚动、焦点切换、外部键盘输入或窗口失焦均立即关闭。
  useEffect(() => {
    const panel = panelRef.current;
    const trigger = triggerRef.current;
    if (!open || !panel) return;
    const doc = panel.ownerDocument;
    const win = doc.defaultView ?? window;
    const contains = (root: Element | null, event: Event) => {
      if (!root) return false;
      const path = typeof event.composedPath === "function" ? event.composedPath() : [];
      if (path.includes(root)) return true;
      const target = event.target;
      return target instanceof Node && root.contains(target);
    };
    const isInsideCardOrTrigger = (event: Event) => contains(panel, event) || contains(trigger, event);
    const dismissOutside = (event: Event) => {
      if (!isInsideCardOrTrigger(event)) setOpenSessionId(undefined);
    };
    const dismissOnScroll = (event: Event) => {
      if (!contains(panel, event)) setOpenSessionId(undefined);
    };
    const dismissOnKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        setOpenSessionId(undefined);
        triggerRef.current?.focus({ preventScroll: true });
        return;
      }
      if (!MODIFIER_KEYS.has(event.key) && !isInsideCardOrTrigger(event)) setOpenSessionId(undefined);
    };
    const dismissAlways = () => setOpenSessionId(undefined);

    doc.addEventListener("pointerdown", dismissOutside, true);
    doc.addEventListener("click", dismissOutside, true);
    doc.addEventListener("focusin", dismissOutside, true);
    doc.addEventListener("wheel", dismissOnScroll, true);
    doc.addEventListener("scroll", dismissOnScroll, true);
    doc.addEventListener("keydown", dismissOnKeyDown, true);
    win.addEventListener("blur", dismissAlways);
    return () => {
      doc.removeEventListener("pointerdown", dismissOutside, true);
      doc.removeEventListener("click", dismissOutside, true);
      doc.removeEventListener("focusin", dismissOutside, true);
      doc.removeEventListener("wheel", dismissOnScroll, true);
      doc.removeEventListener("scroll", dismissOnScroll, true);
      doc.removeEventListener("keydown", dismissOnKeyDown, true);
      win.removeEventListener("blur", dismissAlways);
    };
  }, [open, sessionId]);

  const title = t("backgroundTasks.title");
  const kindLabel = (kind: Task["kind"]) => t(kind === "subagent" ? "nav.subagents" : kind === "browser" ? "backgroundTasks.browser" : "backgroundTasks.command");
  const openTask = (task: Task) => {
    setOpenSessionId(undefined);
    setUnseenSessionId((current) => (current === sessionId ? undefined : current));
    if (task.kind === "browser") {
      openBuiltInBrowserTask(sessionId, task.liveBrowser ? { browserId: task.id, url: task.url } : { url: task.url });
      return;
    }
    if (!sessionId) return;
    (task.kind === "subagent" ? openSubagent : openBackgroundJob)(task.id, sessionId);
  };

  const toggle = tasks.length > 0 ? (
    <TooltipIconButton
      ref={triggerRef}
      tooltip={title}
      aria-expanded={open}
      aria-controls={dockOpen ? undefined : panelId}
      data-slot="background-tasks-toggle"
      data-state={open ? "open" : "closed"}
      className="q-thread-header-action relative"
      onClick={() => {
        if (dockOpen) window.dispatchEvent(new Event(CLOSE_DOCK_PANEL_EVENT));
        const nextOpen = !open;
        setOpenSessionId(nextOpen ? sessionId : undefined);
        if (nextOpen) setUnseenSessionId((current) => (current === sessionId ? undefined : current));
      }}
    >
      <CodexIcon src={tasksIcon} className="size-[18px]" />
      {showIndicator && (
        <span
          aria-hidden="true"
          data-slot="background-tasks-indicator"
          data-active={hasActive ? "" : undefined}
          className="q-background-tasks-indicator"
        />
      )}
    </TooltipIconButton>
  ) : null;

  return <>
    {renderHeader(toggle)}
    <div className="q-chat-body relative flex min-h-0 flex-1 flex-col">
      {!dockOpen && sessionId && tasks.length > 0 && <aside
        key={sessionId}
        ref={panelRef}
        id={panelId}
        aria-label={title}
        inert={!open}
        data-open={open ? "" : undefined}
        className="q-background-tasks"
      >
        <div className="q-background-tasks-card">
          <div className="q-background-tasks-head">
            <span className="q-background-tasks-title">{title}</span>
            <span className="q-background-tasks-count" data-active={hasActive ? "" : undefined} aria-hidden="true">
              {tasks.length}
            </span>
          </div>
          <ul className="q-background-tasks-list">
            {tasks.map((task) => <li key={taskKey(task)} className="min-w-0">
              <button
                type="button"
                title={task.title}
                data-kind={task.kind}
                data-active={task.active ? "" : undefined}
                className="q-background-tasks-row group"
                onClick={() => openTask(task)}
              >
                <span aria-hidden="true" data-kind={task.kind} className="q-background-tasks-icon">
                  {task.kind === "browser" && <CodexBrowserIcon className="size-[15px]" />}
                  {task.kind === "command" && <CodexTerminalIcon className="size-[15px]" />}
                  {task.kind === "subagent" && <CodexRobotIcon className="size-[15px]" />}
                  {task.active && <span className="q-background-tasks-badge-dot" />}
                </span>
                <span className="q-background-tasks-info">
                  <span className={cn("q-background-tasks-name", (task.kind === "command" || task.kind === "browser") && "font-mono text-[12px]")}>
                    {task.name}
                  </span>
                  <span className="q-background-tasks-meta">
                    <span data-kind={task.kind} className="q-background-tasks-kind">{kindLabel(task.kind)}</span>
                    <span aria-hidden="true" className="q-background-tasks-sep">·</span>
                    <span data-active={task.active ? "" : undefined} className="q-background-tasks-status">
                      {t(task.active ? "backgroundTasks.active" : "backgroundTasks.done")}
                    </span>
                  </span>
                </span>
                <CodexChevronRightIcon
                  size={13}
                  aria-hidden="true"
                  className="q-background-tasks-arrow"
                />
              </button>
            </li>)}
          </ul>
        </div>
      </aside>}
      {children}
    </div>
  </>;
}
