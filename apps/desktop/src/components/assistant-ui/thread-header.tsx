import { useEffect, useRef, useState } from "react";
import { DropdownMenu } from "radix-ui";
import { BotMessageSquareIcon, FolderTreeIcon, GlobeIcon, ListTodoIcon, PencilIcon, PinIcon, PinOffIcon, PlugIcon, TrashIcon, WandSparklesIcon } from "lucide-react";
import { CodexIcon } from "../ui/CodexIcon";
import moreIcon from "../../assets/codex-icons/ellipsis-horizontal-light-20.svg";
import terminalIcon from "../../assets/codex-icons/terminal-light-20.svg";
import branchIcon from "../../assets/codex-icons/branch-light-20.svg";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { useSidebarPreferences } from "../../lib/sidebar-preferences";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { TooltipIconButton } from "./tooltip-icon-button";
import "./sidebar-menu.css";
import "./thread-header.css";

export function ThreadHeader({ dockView }: { dockView?: string }) {
  const { t } = useLocale();
  const sessionId = useStore((state) => state.currentSessionId);
  const session = useStore((state) => state.sessions.find((item) => item.id === state.currentSessionId));
  const renameSession = useStore((state) => state.renameSession);
  const deleteSession = useStore((state) => state.deleteSession);
  const pinned = useSidebarPreferences((state) => Boolean(sessionId && state.priorityIds.includes(sessionId)));
  const togglePinned = useSidebarPreferences((state) => state.togglePriority);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState("");
  const cancelRename = useRef(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    setRenaming(false);
  }, [sessionId]);
  useEffect(() => {
    if (renaming) inputRef.current?.select();
  }, [renaming]);

  const startRename = () => {
    cancelRename.current = false;
    setTitle(session?.title ?? "");
    setRenaming(true);
  };
  const finishRename = () => {
    if (!cancelRename.current && sessionId) {
      const nextTitle = title.trim();
      if (nextTitle && nextTitle !== session?.title) renameSession(sessionId, nextTitle);
    }
    setRenaming(false);
  };
  const removeSession = async () => {
    if (!sessionId) return;
    if (await confirmDestructiveAction(t("session.deleteConfirm", { title: session?.title ?? t("sidebar.newChat") }))) {
      deleteSession(sessionId);
    }
  };
  const toggleDockView = (view: string) => window.dispatchEvent(new CustomEvent("qone-toggle-dock-view", { detail: view }));
  const menuViews = [
    { view: "session", icon: ListTodoIcon, label: t("dock.session") },
    { view: "files", icon: FolderTreeIcon, label: t("dock.files") },
    { view: "browser", icon: GlobeIcon, label: t("dock.browser") },
    { view: "mcp", icon: PlugIcon, label: t("dock.mcp") },
    { view: "skills", icon: WandSparklesIcon, label: t("dock.skills") },
    { view: "subagents", icon: BotMessageSquareIcon, label: t("nav.subagents") },
  ] as const;

  return (
    <header className="q-thread-header">
      {renaming ? (
        <input
          ref={inputRef}
          className="q-thread-header-title-input"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          onBlur={finishRename}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
            if (event.key === "Escape") {
              cancelRename.current = true;
              setRenaming(false);
            }
          }}
          aria-label={t("sidebar.renameSession")}
        />
      ) : (
        <span className="q-thread-header-title" title={session?.title ?? t("sidebar.newChat")}>{session?.title || t("sidebar.newChat")}</span>
      )}
      <div className="q-thread-header-actions">
        <DropdownMenu.Root>
          <DropdownMenu.Trigger asChild>
            <button type="button" className="q-thread-header-action" aria-label={t("dock.more")}>
              <CodexIcon src={moreIcon} className="size-[18px]" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content className="q-sidebar-menu" side="bottom" align="end" sideOffset={6} collisionPadding={8}>
              {menuViews.map(({ view, icon: Icon, label }) => (
                <DropdownMenu.Item key={view} className="q-sidebar-menu-item" onSelect={() => toggleDockView(view)}>
                  <Icon className="size-4" /><span>{label}</span>
                </DropdownMenu.Item>
              ))}
              {sessionId && <>
                <DropdownMenu.Separator className="my-1 h-px bg-border/60 dark:bg-white/10" />
                <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={() => togglePinned(sessionId)}>
                  {pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
                  <span>{t(pinned ? "sidebar.unpin" : "sidebar.pin")}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={startRename}>
                  <PencilIcon className="size-4" /><span>{t("sidebar.rename")}</span>
                </DropdownMenu.Item>
                <DropdownMenu.Item className="q-sidebar-menu-item q-sidebar-menu-item-danger" onSelect={removeSession}>
                  <TrashIcon className="size-4" /><span>{t("common.delete")}</span>
                </DropdownMenu.Item>
              </>}
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
        <TooltipIconButton
          tooltip={t("dock.terminal")}
          onClick={() => toggleDockView("terminal")}
          aria-pressed={dockView === "terminal"}
          className="q-thread-header-action"
        >
          <CodexIcon src={terminalIcon} className="size-[18px]" />
        </TooltipIconButton>
        <TooltipIconButton
          tooltip={t("dock.git")}
          onClick={() => toggleDockView("git")}
          aria-pressed={dockView === "git"}
          className="q-thread-header-action"
        >
          <CodexIcon src={branchIcon} className="size-[18px]" />
        </TooltipIconButton>
      </div>
    </header>
  );
}
