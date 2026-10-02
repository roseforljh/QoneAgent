import { useMemo, useRef, useState } from "react";
import { Popover } from "radix-ui";
import type { SessionInfo, WorkspaceInfo } from "@qone/protocol";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { filterSidebarSessions, sortSidebarSessions, sortSidebarWorkspaces, useSidebarPreferences } from "../../lib/sidebar-preferences";
import { CodexIcon } from "../ui/CodexIcon";
import folderIcon from "../../assets/codex-icons/folder-light-16.svg";
import chevronIcon from "../../assets/codex-icons/chevron-right-md-light-16.svg";
import chatIcon from "../../assets/codex-icons/chat-bubble-light-16.svg";
import pinIcon from "../../assets/codex-icons/pin-light-16.svg";
import plusIcon from "../../assets/codex-icons/plus-md-light-16.svg";
import { TooltipIconButton } from "./tooltip-icon-button";
import { SidebarLoadingSkeleton } from "./loading-skeleton";
import { MorphingSpinner } from "./morphing-spinner";
import "./collapsed-sidebar.css";

export function ProjectSessionList({ sessions, currentSessionId, runningIds, onSelect }: {
  sessions: readonly SessionInfo[];
  currentSessionId?: string;
  runningIds: readonly string[];
  onSelect: (id: string) => void;
}) {
  const { t } = useLocale();
  const running = new Set(runningIds);
  return sessions.length ? sessions.map((session) => <button key={session.id} type="button"
    className="q-project-popover-row" aria-current={session.id === currentSessionId ? "page" : undefined}
    onClick={() => onSelect(session.id)} title={session.title || t("sidebar.newChat")}>
    <CodexIcon src={chatIcon} className="size-4 shrink-0 text-muted-foreground" />
    <span className="min-w-0 flex-1 truncate">{session.title || t("sidebar.newChat")}</span>
    {running.has(session.id) && <MorphingSpinner className="size-3.5 shrink-0" />}
  </button>) : <p className="q-project-popover-empty">{t("sidebar.noChatsInProject")}</p>;
}

function ProjectSessions({ workspace, onClose }: { workspace: WorkspaceInfo; onClose: () => void }) {
  const { t } = useLocale();
  const sessions = useStore((state) => state.sessions);
  const loaded = useStore((state) => state.sessionsLoaded);
  const currentSessionId = useStore((state) => state.currentSessionId);
  const runningIds = useStore((state) => state.runningSessionIds);
  const selectSession = useStore((state) => state.selectSession);
  const newSession = useStore((state) => state.newSessionInWorkspace);
  const preferences = useSidebarPreferences();
  // The expanded sidebar moves pinned chats into their own section. This card
  // must retain every chat belonging to the selected project, including pins.
  const projectSessions = useMemo(() => sortSidebarSessions(
    filterSidebarSessions(sessions, workspace.id, []), preferences,
  ), [sessions, workspace.id, preferences]);
  return <>
    <div className="q-project-popover-heading">
      <span className="min-w-0 flex-1 truncate" title={workspace.path}>{workspace.name}</span>
      <TooltipIconButton tooltip={t("sidebar.newChatInProject", { name: workspace.name })}
        onClick={() => { newSession(workspace.id); onClose(); }}>
        <CodexIcon src={plusIcon} className="size-4" />
      </TooltipIconButton>
    </div>
    <div className="q-project-popover-list">
      {loaded ? <ProjectSessionList sessions={projectSessions} currentSessionId={currentSessionId}
        runningIds={runningIds} onSelect={(id) => { selectSession(id); onClose(); }} />
        : <SidebarLoadingSkeleton layout="list" />}
    </div>
  </>;
}

export function SidebarProjectsPopover() {
  const { t } = useLocale();
  const [open, setOpen] = useState(false);
  const [projectId, setProjectId] = useState<string>();
  const sessionsCard = useRef<HTMLDivElement>(null);
  const workspaces = useStore((state) => state.workspaces);
  const loaded = useStore((state) => state.workspacesLoaded);
  const pinnedIds = useStore((state) => state.pinnedWorkspaceIds);
  const chooseWorkspace = useStore((state) => state.chooseWorkspace);
  const order = useSidebarPreferences((state) => state.workspaceOrder);
  const projects = useMemo(() => {
    const pinned = new Set(pinnedIds);
    return sortSidebarWorkspaces(workspaces, order).sort((a, b) => Number(pinned.has(b.id)) - Number(pinned.has(a.id)));
  }, [workspaces, order, pinnedIds]);
  const changeOpen = (next: boolean) => { setOpen(next); setProjectId(undefined); };
  const close = () => changeOpen(false);
  return <Popover.Root open={open} onOpenChange={changeOpen}>
    <Popover.Trigger asChild>
      <TooltipIconButton tooltip={t("sidebar.projects")} className="q-sidebar-rail-action">
        <CodexIcon src={folderIcon} className="size-4" />
      </TooltipIconButton>
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Content className="q-project-popover" side="right" align="start" sideOffset={10} collisionPadding={12}
        aria-label={t("sidebar.projects")} onInteractOutside={(event) => {
          // Nested cards are portalled; interacting with the session card is
          // still inside this project picker and must not dismiss its parent.
          if (sessionsCard.current?.contains(event.target as Node)) event.preventDefault();
        }}>
        <div className="q-project-popover-heading">
          <span className="flex-1">{t("sidebar.projects")}</span>
          <TooltipIconButton tooltip={t("chat.importProject")} onClick={() => { close(); chooseWorkspace(); }}>
            <CodexIcon src={plusIcon} className="size-4" />
          </TooltipIconButton>
        </div>
        <div className="q-project-popover-list">
          {!loaded ? <SidebarLoadingSkeleton layout="project" /> : projects.length ? projects.map((workspace) => (
            <Popover.Root key={workspace.id} open={projectId === workspace.id}
              onOpenChange={(next) => setProjectId((current) => next ? workspace.id : current === workspace.id ? undefined : current)}>
              <Popover.Trigger asChild>
                <button type="button" className="q-project-popover-row" title={workspace.path}>
                  <CodexIcon src={folderIcon} className="size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
                  {pinnedIds.includes(workspace.id) && <CodexIcon src={pinIcon} className="size-3 shrink-0 text-muted-foreground" />}
                  <CodexIcon src={chevronIcon} className="size-3.5 shrink-0 text-muted-foreground" />
                </button>
              </Popover.Trigger>
              <Popover.Portal>
                <Popover.Content ref={sessionsCard} className="q-project-popover q-project-sessions-popover"
                  side="right" align="start" sideOffset={10} collisionPadding={12} aria-label={workspace.name}>
                  <ProjectSessions workspace={workspace} onClose={close} />
                </Popover.Content>
              </Popover.Portal>
            </Popover.Root>
          )) : <p className="q-project-popover-empty">{t("sidebar.noProjects")}</p>}
        </div>
      </Popover.Content>
    </Popover.Portal>
  </Popover.Root>;
}
