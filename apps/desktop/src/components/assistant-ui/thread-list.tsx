import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { AnimatedSidebarIcon } from "../ui/AnimatedSidebarIcon";
import { CodexIcon } from "../ui/CodexIcon";
import moreIcon from "../../assets/codex-icons/ellipsis-horizontal-light-16.svg";
import pinIcon from "../../assets/codex-icons/pin-light-16.svg";
import pinOffIcon from "../../assets/codex-icons/pin-slash-light-16.svg";
import pencilIcon from "../../assets/codex-icons/pencil-light-16.svg";
import trashIcon from "../../assets/codex-icons/trash-light-16.svg";
import { Fragment, forwardRef, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type FC } from "react";
import { useStore } from "../../store";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { useSidebarPreferences } from "../../lib/sidebar-preferences";
import { useLocale, type MessageKey } from "../../localization";
import "./sidebar-menu.css";
import { MorphingSpinner } from "./morphing-spinner";
import { SidebarSessionTitle } from "./sidebar-session-title";
import { SidebarSessionActions } from "./sidebar-session-pin-action";
import { SidebarContextMenu } from "./sidebar-menu";
import { useSidebarDrag } from "../../hooks/use-sidebar-drag";
import "./sidebar-drag.css";

export const ThreadListRoot: FC<ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>> = ({ className, ...props }) => {
  const dragRef = useSidebarDrag();
  return <ThreadListPrimitive.Root ref={dragRef} data-slot="aui_thread-list-root" className={cn("flex flex-col gap-0.5", className)} {...props} />;
};

export const ThreadListItems: FC<ComponentPropsWithoutRef<"div">> = ({ className, ...props }) => {
  return (
    <div data-slot="aui_thread-list-items" className={cn("flex flex-col gap-0.5", className)} {...props}>
      <ThreadListItemGroups />
    </div>
  );
};

const DAY_IN_MS = 86_400_000;

const dateGroupLabel = (date: Date | undefined, startOfToday: number): MessageKey => {
  if (!date || date.getTime() >= startOfToday) return "sidebar.today";
  if (date.getTime() >= startOfToday - DAY_IN_MS) return "sidebar.yesterday";
  return "sidebar.earlier";
};

const ThreadListItemGroups: FC = () => {
  const { t } = useLocale();
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);
  const sort = useSidebarPreferences((state) => state.sort);
  const priorityIds = useSidebarPreferences((state) => state.priorityIds);

  const { pinnedIndices, regularIndices } = useMemo(() => {
    const pinned = new Set(priorityIds);
    const pinnedIndices: number[] = [];
    const regularIndices: number[] = [];
    threadIds.forEach((id, index) => (pinned.has(id) ? pinnedIndices : regularIndices).push(index));
    return { pinnedIndices, regularIndices };
  }, [threadIds, priorityIds]);

  const groups = useMemo(() => {
    // Date headings would split a manually ordered list into repeated date groups.
    if (sort === "manual") return null;
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    if (!regularIndices.some((index) => dates[index])) return null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = (index: number) => dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = sort === "recent"
      ? [...regularIndices].sort((a, b) => time(b) - time(a))
      : regularIndices;
    const result: { label: MessageKey; indices: number[] }[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], startOfToday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) lastGroup.indices.push(index);
      else result.push({ label, indices: [index] });
    }
    return result;
  }, [threadIds, threadItems, sort, regularIndices]);

  return <>
    {pinnedIndices.length > 0 && <div className="q-sidebar-section-label px-1.5 pt-2 pb-1 text-sm font-semibold">{t("sidebar.pinnedProjects")}</div>}
    {pinnedIndices.map((index) => <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />)}
    {groups ? groups.map((group) => (
      <Fragment key={`${group.label}:${threadIds[group.indices[0]]}`}>
        <div data-slot="aui_thread-list-group-label" className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium">
          {t(group.label)}
        </div>
        {group.indices.map((index) => (
          <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />
        ))}
      </Fragment>
    )) : regularIndices.map((index) => (
      <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />
    ))}
  </>;
};

export const ThreadListNew = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }>(
  ({ className, labelClassName, children, ...props }, ref) => {
    const { t } = useLocale();
    return (
      <ThreadListPrimitive.New asChild>
        <Button
          ref={ref}
          variant="ghost"
          data-slot="aui_thread-list-new"
          className={cn("group hover:bg-muted text-foreground/95 hover:text-foreground data-active:bg-muted h-10 justify-start gap-2.5 rounded-md px-2.5", className)}
          {...props}
        >
          {children ?? (
            <>
              <AnimatedSidebarIcon kind="new-chat" />
              <span data-slot="aui_thread-list-new-label" className={cn("whitespace-nowrap", labelClassName)}>{t("sidebar.newChat")}</span>
            </>
          )}
        </Button>
      </ThreadListPrimitive.New>
    );
  },
);
ThreadListNew.displayName = "ThreadListNew";

export const ThreadListItem: FC = () => {
  const id = useAuiState((s) => s.threadListItem.id);
  const isRunning = useStore((s) => s.runningSessionIds.includes(id));
  const sessions = useStore((s) => s.sessions);
  const renameSession = useStore((s) => s.renameSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const { t } = useLocale();
  const session = sessions.find((item) => item.id === id);
  const pinned = useSidebarPreferences((s) => s.priorityIds.includes(id));
  const togglePriority = useSidebarPreferences((s) => s.togglePriority);
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session?.title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);
  useEffect(() => { if (!renaming && session) setTitle(session.title); }, [session?.title, renaming]);
  const submitRename = () => { const next = title.trim(); if (next && next !== session?.title) renameSession(id, next); setRenaming(false); };
  const deleteChat = async () => {
    if (await confirmDestructiveAction(t("session.deleteConfirm", { title: session?.title ?? t("sidebar.newChat") }))) deleteSession(id);
  };

  return (
    <SidebarContextMenu
      pinned={pinned}
      onTogglePinned={() => togglePriority(id)}
      onRename={() => setRenaming(true)}
      onDelete={deleteChat}
      disabled={renaming}
    >
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="q-sidebar-session-row group relative flex h-[30px] items-center rounded-[10px] transition-colors"
      data-sidebar-drag-id={renaming ? undefined : id}
      data-sidebar-drag-kind="session"
      data-sidebar-drag-group={pinned ? "session:pinned" : "session:list"}
    >
      {renaming ? <input ref={inputRef} value={title} onChange={(event) => setTitle(event.target.value)} onBlur={submitRename} onKeyDown={(event) => { if (event.key === "Enter") submitRename(); if (event.key === "Escape") { setTitle(session?.title ?? ""); setRenaming(false); } }} className="border-input bg-background focus:border-ring mx-1 h-6 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none" aria-label={t("sidebar.renameSession")} /> : <ThreadListItemPrimitive.Trigger
        data-slot="aui_thread-list-item-trigger"
        data-sidebar-drag-handle=""
        className="q-sidebar-session-trigger text-foreground/95 group-hover:text-foreground group-data-active:text-foreground flex h-full min-w-0 flex-1 items-center rounded-[10px] px-2 text-start outline-none"
      >
        <span data-slot="aui_thread-list-item-title" className="flex min-w-0 flex-1">
          <SidebarSessionTitle title={session?.title || t("sidebar.newChat")}>
            <ThreadListItemPrimitive.Title fallback={t("sidebar.newChat")} />
          </SidebarSessionTitle>
        </span>
        {isRunning && <span className="sr-only">{t("goal.active")}</span>}
      </ThreadListItemPrimitive.Trigger>}
      {!renaming && <ThreadListItemMore isRunning={isRunning} onRename={() => setRenaming(true)} onDelete={deleteChat} />}
    </ThreadListItemPrimitive.Root>
    </SidebarContextMenu>
  );
};

const ThreadListItemMore: FC<{ isRunning: boolean; onRename: () => void; onDelete: () => void | Promise<void> }> = ({ isRunning, onRename, onDelete }) => {
  const { t } = useLocale();
  const id = useAuiState((s) => s.threadListItem.id);
  const priority = useSidebarPreferences((s) => s.priorityIds.includes(id));
  const togglePriority = useSidebarPreferences((s) => s.togglePriority);
  return (
    <SidebarSessionActions pinned={priority} onTogglePinned={() => togglePriority(id)} status={isRunning ? <MorphingSpinner data-slot="aui_thread-list-item-running" className="size-3.5" /> : undefined}>
      <ThreadListItemMorePrimitive.Root sharedFocusGroup>
        <ThreadListItemMorePrimitive.Trigger asChild>
          <Button
            variant="ghost"
            size="icon"
            data-slot="aui_thread-list-item-more"
            className="data-[state=open]:bg-accent size-6 shrink-0 p-0 focus-visible:ring-0"
          >
            <CodexIcon src={moreIcon} className="size-3.5" />
            <span className="sr-only">{t("sidebar.chatOptions")}</span>
          </Button>
        </ThreadListItemMorePrimitive.Trigger>
        <ThreadListItemMorePrimitive.Content
          side="right"
          align="start"
          sideOffset={6}
          collisionPadding={8}
          data-slot="aui_thread-list-item-more-content"
          className="q-sidebar-menu"
        >
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            onSelect={() => togglePriority(id)}
            className="q-sidebar-menu-item"
          >
            <CodexIcon src={priority ? pinOffIcon : pinIcon} className="size-4" />
            <span>{t(priority ? "sidebar.unpin" : "sidebar.pin")}</span>
          </ThreadListItemMorePrimitive.Item>
          <ThreadListItemMorePrimitive.Item data-slot="aui_thread-list-item-more-item" onSelect={onRename} className="q-sidebar-menu-item">
            <CodexIcon src={pencilIcon} className="size-4" />
            <span>{t("sidebar.rename")}</span>
          </ThreadListItemMorePrimitive.Item>
          <ThreadListItemMorePrimitive.Item data-slot="aui_thread-list-item-more-item" onSelect={onDelete} className="q-sidebar-menu-item q-sidebar-menu-item-danger">
            <CodexIcon src={trashIcon} className="size-4" />
            <span>{t("common.delete")}</span>
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemMorePrimitive.Content>
      </ThreadListItemMorePrimitive.Root>
    </SidebarSessionActions>
  );
};
