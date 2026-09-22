import { cn } from "../../lib/utils";
import { useStore } from "../../store";
import type { WorkspaceInfo } from "@qone/protocol";
import { AnimatePresence, motion } from "motion/react";
import {
  ChevronRightIcon,
  FolderIcon,
  FolderPlusIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  PlusIcon,
  RefreshCwIcon,
  TrashIcon,
} from "lucide-react";
import { useEffect, useRef, useState, type FC, type ReactNode } from "react";

const menuItemClass =
  "group hover:bg-accent hover:text-accent-foreground dark:hover:bg-white/10 flex w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-[13px] text-foreground/85 outline-none transition-all active:scale-[0.98]";

const menuCardClass =
  "bg-popover/95 dark:bg-[#18181b]/95 text-popover-foreground backdrop-blur-md absolute right-0 top-full z-50 mt-1.5 w-40 origin-top-right overflow-hidden rounded-xl border border-border/80 dark:border-white/[0.12] p-1 shadow-xl shadow-black/10 dark:shadow-2xl dark:shadow-black/60";

const ProjectRowMenu: FC<{ workspace: WorkspaceInfo; pinned: boolean; onClose: () => void }> = ({ workspace, pinned, onClose }) => {
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const deleteWorkspace = useStore((s) => s.deleteWorkspace);
  const togglePinWorkspace = useStore((s) => s.togglePinWorkspace);
  const [renaming, setRenaming] = useState(false);
  const [name, setName] = useState(workspace.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const submitRename = () => {
    if (name.trim() && name.trim() !== workspace.name) renameWorkspace(workspace.id, name);
    onClose();
  };

  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -4 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        className={menuCardClass}
      >
        {renaming ? (
          <div className="p-1">
            <input
              ref={inputRef}
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") submitRename();
                if (e.key === "Escape") onClose();
              }}
              onBlur={submitRename}
              className="border-input bg-background/80 focus:border-ring h-7 w-full rounded-lg border px-2 text-xs outline-none transition-colors"
              aria-label="重命名项目"
            />
          </div>
        ) : (
          <div className="flex flex-col gap-0.5">
            <button className={menuItemClass} onClick={() => setRenaming(true)}>
              <PencilIcon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground shrink-0" />
              <span>重命名</span>
            </button>
            <button className={menuItemClass} onClick={() => { togglePinWorkspace(workspace.id); onClose(); }}>
              {pinned ? (
                <PinOffIcon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground shrink-0" />
              ) : (
                <PinIcon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground shrink-0" />
              )}
              <span>{pinned ? "取消置顶" : "置顶"}</span>
            </button>
            <div className="my-1 h-px bg-border/60 dark:bg-white/10" />
            <button
              className={cn(
                menuItemClass,
                "text-destructive/90 hover:bg-destructive/10 hover:text-destructive dark:text-red-400 dark:hover:bg-red-500/15 dark:hover:text-red-300",
              )}
              onClick={() => { deleteWorkspace(workspace.id); onClose(); }}
            >
              <TrashIcon className="size-4 text-destructive/80 transition-colors group-hover:text-destructive dark:text-red-400/80 dark:group-hover:text-red-300 shrink-0" />
              <span>删除</span>
            </button>
          </div>
        )}
      </motion.div>
    </>
  );
};

const ProjectRow: FC<{ workspace: WorkspaceInfo }> = ({ workspace }) => {
  const pinnedWorkspaceIds = useStore((s) => s.pinnedWorkspaceIds);
  const currentWorkspaceId = useStore((s) => s.currentWorkspaceId);
  const selectWorkspace = useStore((s) => s.selectWorkspace);
  const newSessionInWorkspace = useStore((s) => s.newSessionInWorkspace);
  const [menuOpen, setMenuOpen] = useState(false);
  const pinned = pinnedWorkspaceIds.includes(workspace.id);
  const active = currentWorkspaceId === workspace.id;

  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.15, ease: "easeOut" }}
      className={cn(
        "group hover:bg-muted relative flex h-9 items-center rounded-md transition-colors",
        (active || menuOpen) && "bg-muted",
      )}
    >
      <button
        className="q-sidebar-project-trigger text-foreground/95 group-hover:text-foreground flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2.5 text-start outline-none transition-colors"
        onClick={() => selectWorkspace(workspace.id)}
        title={workspace.path}
      >
        <FolderIcon className="text-muted-foreground size-4 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{workspace.name}</span>
        {pinned && <PinIcon className="text-muted-foreground size-3 shrink-0" />}
      </button>
      <div className={cn("flex shrink-0 items-center pr-1.5 opacity-0 transition-opacity group-hover:opacity-100", menuOpen && "opacity-100")}>
        <button
          className="text-muted-foreground hover:text-foreground grid size-6 cursor-pointer place-items-center rounded-md transition-colors"
          aria-label="在此项目下新建会话"
          title="新建会话"
          onClick={() => newSessionInWorkspace(workspace.id)}
        >
          <PlusIcon className="size-3.5" />
        </button>
        <button
          className={cn("text-muted-foreground hover:text-foreground grid size-6 cursor-pointer place-items-center rounded-md transition-colors", menuOpen && "bg-accent text-foreground")}
          aria-label="项目选项"
          onClick={() => setMenuOpen((v) => !v)}
        >
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      </div>
      <AnimatePresence>
        {menuOpen && <ProjectRowMenu workspace={workspace} pinned={pinned} onClose={() => setMenuOpen(false)} />}
      </AnimatePresence>
    </motion.div>
  );
};

const SectionMenu: FC<{ onClose: () => void }> = ({ onClose }) => {
  const chooseWorkspace = useStore((s) => s.chooseWorkspace);
  const refreshWorkspace = useStore((s) => s.refreshWorkspace);
  return (
    <>
      <div className="fixed inset-0 z-40" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <motion.div
        initial={{ opacity: 0, scale: 0.96, y: -4 }}
        animate={{ opacity: 1, scale: 1, y: 0 }}
        exit={{ opacity: 0, scale: 0.96, y: -4 }}
        transition={{ duration: 0.12, ease: "easeOut" }}
        className={menuCardClass}
      >
        <div className="flex flex-col gap-0.5">
          <button className={menuItemClass} onClick={() => { chooseWorkspace(); onClose(); }}>
            <FolderPlusIcon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground shrink-0" />
            <span>导入文件夹</span>
          </button>
          <button className={menuItemClass} onClick={() => { refreshWorkspace(); onClose(); }}>
            <RefreshCwIcon className="size-4 text-muted-foreground transition-colors group-hover:text-foreground shrink-0" />
            <span>刷新文件</span>
          </button>
        </div>
      </motion.div>
    </>
  );
};

const ProjectGroup: FC<{
  label: string;
  workspaces: WorkspaceInfo[];
  emptyText: string;
  defaultOpen?: boolean;
  actions?: ReactNode;
}> = ({ label, workspaces, emptyText, defaultOpen = true, actions }) => {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div>
      <div className="group/section relative flex h-7 items-center">
        <button
          className="q-sidebar-section-label text-muted-foreground hover:text-foreground flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 px-1.5 text-[13px] font-semibold transition-colors"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          {label}
          <motion.span animate={{ rotate: open ? 90 : 0 }} transition={{ duration: 0.15 }} className="grid place-items-center">
            <ChevronRightIcon className="size-3.5" />
          </motion.span>
        </button>
        {actions}
      </div>
      <AnimatePresence initial={false}>
        {open && (
          <motion.div
            key={label}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: "auto", opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeInOut" }}
            className="overflow-hidden"
          >
            <div className="flex flex-col gap-0.5 pb-1">
              <AnimatePresence initial={false} mode="popLayout">
                {workspaces.map((workspace) => <ProjectRow key={workspace.id} workspace={workspace} />)}
              </AnimatePresence>
              {workspaces.length === 0 && (
                <p className="q-sidebar-empty text-muted-foreground px-2.5 py-1 text-xs">{emptyText}</p>
              )}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
};

export const ProjectSection: FC = () => {
  const workspaces = useStore((s) => s.workspaces);
  const pinnedWorkspaceIds = useStore((s) => s.pinnedWorkspaceIds);
  const chooseWorkspace = useStore((s) => s.chooseWorkspace);
  const [sectionMenuOpen, setSectionMenuOpen] = useState(false);
  const pinned = workspaces.filter((w) => pinnedWorkspaceIds.includes(w.id));

  return (
    <div className="flex flex-col">
      <ProjectGroup label="置顶" workspaces={pinned} emptyText="暂无置顶项目" />
      <ProjectGroup
        label="项目"
        workspaces={workspaces}
        emptyText="暂无项目"
        actions={
          <div className="flex shrink-0 items-center pr-1 opacity-0 transition-opacity group-hover/section:opacity-100 data-[open=true]:opacity-100" data-open={sectionMenuOpen}>
            <button
              className={cn("text-muted-foreground hover:text-foreground grid size-6 cursor-pointer place-items-center rounded-md transition-colors", sectionMenuOpen && "bg-accent text-foreground")}
              aria-label="项目区选项"
              onClick={() => setSectionMenuOpen((v) => !v)}
            >
              <MoreHorizontalIcon className="size-3.5" />
            </button>
            <button
              className="text-muted-foreground hover:text-foreground grid size-6 cursor-pointer place-items-center rounded-md transition-colors"
              aria-label="导入项目文件夹"
              title="导入项目文件夹"
              onClick={chooseWorkspace}
            >
              <PlusIcon className="size-3.5" />
            </button>
            <AnimatePresence>
              {sectionMenuOpen && <SectionMenu onClose={() => setSectionMenuOpen(false)} />}
            </AnimatePresence>
          </div>
        }
      />
    </div>
  );
};
