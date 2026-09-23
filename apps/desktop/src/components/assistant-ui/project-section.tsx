import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import type { SessionInfo, WorkspaceInfo } from "@qone/protocol";
import { AnimatePresence, motion } from "motion/react";
import { FolderIcon, FolderOpenIcon, Loader2Icon, PlusIcon, PinIcon } from "lucide-react";
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";
import { SidebarEntityMenu, SidebarMenu } from "./sidebar-menu";
import { useLocale } from "../../localization";
import { useSidebarPreferences, sortSidebarSessions } from "../../lib/sidebar-preferences";

const rowButtonClass = "text-foreground/95 group-hover:text-foreground flex h-full min-w-0 flex-1 items-center gap-2 rounded-md px-2 text-start outline-none transition-colors";

const SessionRow: FC<{ session: SessionInfo }> = ({ session }) => {
  const { t } = useLocale();
  const currentSessionId = useStore((s) => s.currentSessionId);
  const selectSession = useStore((s) => s.selectSession);
  const renameSession = useStore((s) => s.renameSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const priority = useSidebarPreferences((s) => s.priorityIds.includes(session.id));
  const titleGenerating = useStore((s) => s.titleGeneratingSessionIds.includes(session.id));
  const togglePriority = useSidebarPreferences((s) => s.togglePriority);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session.title);
  const inputRef = useRef<HTMLInputElement>(null);
  const active = currentSessionId === session.id;
  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);
  const submitRename = () => { const next = title.trim(); if (next && next !== session.title) renameSession(session.id, next); setRenaming(false); };
  return <motion.div layout className={cn("group relative flex h-8 items-center rounded-md", (active || renaming) && "bg-muted")}>
    {renaming ? <input ref={inputRef} value={title} onChange={(event) => setTitle(event.target.value)} onBlur={submitRename} onKeyDown={(event) => { if (event.key === "Enter") submitRename(); if (event.key === "Escape") { setTitle(session.title); setRenaming(false); } }} className="border-input bg-background focus:border-ring mx-1 h-6 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none" aria-label={t("sidebar.renameSession")} /> : <button type="button" className={rowButtonClass} onClick={() => selectSession(session.id)}>
      {active && <span className="size-1.5 shrink-0 rounded-full bg-foreground/60" aria-hidden="true" />}
      {titleGenerating && <Loader2Icon className="text-muted-foreground size-3.5 shrink-0 animate-spin" aria-label={t("chat.generatingTitle")} />}
      <span className="min-w-0 flex-1 truncate">{session.title || t("sidebar.newChat")}</span>{priority && <PinIcon className="text-muted-foreground size-3 shrink-0" />}
    </button>}
    {!renaming && <div className={cn("absolute end-1 top-1/2 -translate-y-1/2 opacity-0 transition-opacity group-hover:opacity-100", active && "opacity-100")}><SidebarEntityMenu pinned={priority} onTogglePinned={() => togglePriority(session.id)} onRename={() => setRenaming(true)} onDelete={async () => { if (await confirmDestructiveAction(t("session.deleteConfirm", { title: session.title || t("sidebar.newChat") }))) deleteSession(session.id); }} ariaLabel={t("sidebar.chatOptions")} /></div>}
  </motion.div>;
};

const ProjectRow: FC<{ workspace: WorkspaceInfo; sessions: SessionInfo[] }> = ({ workspace, sessions }) => {
  const { t } = useLocale();
  const pinnedWorkspaceIds = useStore((s) => s.pinnedWorkspaceIds);
  const currentWorkspaceId = useStore((s) => s.currentWorkspaceId);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const newSessionInWorkspace = useStore((s) => s.newSessionInWorkspace);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const deleteWorkspace = useStore((s) => s.deleteWorkspace);
  const togglePinWorkspace = useStore((s) => s.togglePinWorkspace);
  const sidebarPreferences = useSidebarPreferences();
  const [expanded, setExpanded] = useState(currentWorkspaceId === workspace.id);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(workspace.name);
  const inputRef = useRef<HTMLInputElement>(null);
  const pinned = pinnedWorkspaceIds.includes(workspace.id);
  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);
  const submitRename = () => { const next = name.trim(); if (next && next !== workspace.name) renameWorkspace(workspace.id, next); setRenaming(false); };
  const projectSessions = sortSidebarSessions(sessions.filter((session) => session.workspaceId === workspace.id), sidebarPreferences);
  return <motion.div layout initial={{ opacity: 0, y: 4 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: -4 }} className="relative">
    <div className={cn("group relative flex h-9 items-center rounded-md transition-colors", renaming && "bg-muted")}>
      {renaming ? <input ref={inputRef} value={name} onChange={(event) => setName(event.target.value)} onBlur={submitRename} onKeyDown={(event) => { if (event.key === "Enter") submitRename(); if (event.key === "Escape") { setName(workspace.name); setRenaming(false); } }} className="border-input bg-background focus:border-ring mx-1 h-7 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none" aria-label={t("sidebar.renameProject")} /> : <button type="button" className={rowButtonClass} onClick={() => { selectWorkspace(workspace.id); setExpanded((value) => !value); }} title={workspace.path} aria-expanded={expanded}>
        {expanded ? <FolderOpenIcon className="text-muted-foreground size-4 shrink-0" /> : <FolderIcon className="text-muted-foreground size-4 shrink-0" />}<span className="min-w-0 flex-1 truncate">{workspace.name}</span>{pinned && <PinIcon className="text-muted-foreground size-3 shrink-0" />}
      </button>}
      <SidebarEntityMenu pinned={pinned} onTogglePinned={() => togglePinWorkspace(workspace.id)} onRename={() => setRenaming(true)} onDelete={async () => { if (await confirmDestructiveAction(t("workspace.deleteConfirm", { name: workspace.name }))) deleteWorkspace(workspace.id); }} ariaLabel={t("sidebar.projectOptions", { name: workspace.name })} />
      <button type="button" className="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded-md" aria-label={t("sidebar.newChatInProject", { name: workspace.name })} title={t("sidebar.newChat")} onClick={() => { setExpanded(true); newSessionInWorkspace(workspace.id); }}><PlusIcon className="size-3.5" /></button>
    </div>
    <AnimatePresence initial={false}>{expanded && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden ps-5"><div className="flex flex-col gap-0.5 border-s border-border/50 ps-1 pb-1">{projectSessions.length ? projectSessions.map((session) => <SessionRow key={session.id} session={session} />) : <p className="text-muted-foreground px-2 py-1 text-xs">{t("sidebar.noChatsInProject")}</p>}</div></motion.div>}</AnimatePresence>
  </motion.div>;
};

const ProjectGroup: FC<{ label: string; workspaces: WorkspaceInfo[]; sessions: SessionInfo[]; emptyText: string; defaultOpen?: boolean; actions?: ReactNode }> = ({ label, workspaces, sessions, emptyText, defaultOpen = true, actions }) => {
  const [open, setOpen] = useState(defaultOpen);
  return <div><div className="group/section relative flex h-7 items-center"><button type="button" className="q-sidebar-section-label text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center px-1.5 text-[13px] font-semibold transition-colors" onClick={() => setOpen((value) => !value)} aria-expanded={open}><span>{label}</span></button>{actions}</div><AnimatePresence initial={false}>{open && <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} className="overflow-hidden"><div className="flex flex-col gap-0.5 pb-1"><AnimatePresence initial={false} mode="popLayout">{workspaces.map((workspace) => <ProjectRow key={workspace.id} workspace={workspace} sessions={sessions} />)}</AnimatePresence>{workspaces.length === 0 && <p className="q-sidebar-empty text-muted-foreground px-2.5 py-1 text-xs">{emptyText}</p>}</div></motion.div>}</AnimatePresence></div>;
};

export const ProjectSection: FC = () => {
  const { t } = useLocale();
  const workspaces = useStore((s) => s.workspaces);
  const sessions = useStore((s) => s.sessions);
  const pinnedWorkspaceIds = useStore((s) => s.pinnedWorkspaceIds);
  const chooseWorkspace = useStore((s) => s.chooseWorkspace);
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);
  const pinned = workspaces.filter((workspace) => pinnedWorkspaceIds.includes(workspace.id));
  const regular = workspaces.filter((workspace) => !pinnedWorkspaceIds.includes(workspace.id));
  return <div className="flex flex-col"><ProjectGroup label={t("sidebar.pinnedProjects")} workspaces={pinned} sessions={sessions} emptyText={t("sidebar.noPinnedProjects")} /><ProjectGroup label={t("sidebar.projects")} workspaces={regular} sessions={sessions} emptyText={t("sidebar.noProjects")} actions={<div className={cn("flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover/section:opacity-100", sectionMenuOpen && "opacity-100")}><SidebarMenu trigger="more" onOpenChange={setSectionMenuOpen} /><button type="button" className="text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded-md" aria-label={t("chat.importProject")} title={t("chat.importProject")} onClick={chooseWorkspace}><PlusIcon className="size-3.5" /></button></div>} /></div>;
};
