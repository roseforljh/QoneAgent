import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { MoreHorizontalIcon, PencilIcon, PinIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Fragment, forwardRef, useEffect, useMemo, useRef, useState, type ComponentPropsWithoutRef, type FC } from "react";
import { useStore } from "../../store";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { useSidebarPreferences } from "../../lib/sidebar-preferences";
import { useLocale, type MessageKey } from "../../localization";
import "./sidebar-menu.css";
import { MorphingSpinner } from "./morphing-spinner";

export const ThreadListRoot: FC<ComponentPropsWithoutRef<typeof ThreadListPrimitive.Root>> = ({ className, ...props }) => {
  return <ThreadListPrimitive.Root data-slot="aui_thread-list-root" className={cn("flex flex-col gap-0.5", className)} {...props} />;
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

  const groups = useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    if (!dates.some(Boolean)) return null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = (index: number) => dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = sort === "recent"
      ? threadIds.map((_, index) => index).sort((a, b) => time(b) - time(a))
      : threadIds.map((_, index) => index);
    const result: { label: MessageKey; indices: number[] }[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], startOfToday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) lastGroup.indices.push(index);
      else result.push({ label, indices: [index] });
    }
    return result;
  }, [threadIds, threadItems, sort]);

  if (!groups) {
    return threadIds.map((id, index) => (
      <ThreadListPrimitive.ItemByIndex key={id} index={index} components={{ ThreadListItem }} />
    ));
  }

  return groups.map((group) => (
    <Fragment key={`${group.label}:${threadIds[group.indices[0]]}`}>
      <div data-slot="aui_thread-list-group-label" className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium">
        {t(group.label)}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />
      ))}
    </Fragment>
  ));
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
          className={cn("hover:bg-muted text-foreground/95 hover:text-foreground data-active:bg-muted h-10 justify-start gap-2.5 rounded-md px-2.5", className)}
          {...props}
        >
          {children ?? (
            <>
              <PlusIcon data-slot="aui_thread-list-new-icon" className="size-4 shrink-0" />
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
  const isRunning = useAuiState((s) => s.threadListItem.isRunning);
  const id = useAuiState((s) => s.threadListItem.id);
  const sessions = useStore((s) => s.sessions);
  const renameSession = useStore((s) => s.renameSession);
  const deleteSession = useStore((s) => s.deleteSession);
  const { t } = useLocale();
  const session = sessions.find((item) => item.id === id);
  const sort = useSidebarPreferences((s) => s.sort);
  const moveSession = useSidebarPreferences((s) => s.moveSession);
  const [dropEdge, setDropEdge] = useState<"before" | "after" | undefined>();
  const [renaming, setRenaming] = useState(false);
  const [title, setTitle] = useState(session?.title ?? "");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => { if (renaming) inputRef.current?.select(); }, [renaming]);
  useEffect(() => { if (!renaming && session) setTitle(session.title); }, [session?.title, renaming]);
  const submitRename = () => { const next = title.trim(); if (next && next !== session?.title) renameSession(id, next); setRenaming(false); };

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
      draggable={sort === "manual"}
      data-drop-edge={dropEdge}
      onDragStart={(event) => event.dataTransfer.setData("text/plain", id)}
      onDragOver={(event) => {
        if (sort !== "manual") return;
        event.preventDefault();
        setDropEdge(event.nativeEvent.offsetY < event.currentTarget.clientHeight / 2 ? "before" : "after");
      }}
      onDragLeave={() => setDropEdge(undefined)}
      onDrop={(event) => {
        if (sort !== "manual") return;
        event.preventDefault();
        const source = event.dataTransfer.getData("text/plain");
        moveSession(sessions, source, id, event.nativeEvent.offsetY >= event.currentTarget.clientHeight / 2);
        setDropEdge(undefined);
      }}
    >
      {renaming ? <input ref={inputRef} value={title} onChange={(event) => setTitle(event.target.value)} onBlur={submitRename} onKeyDown={(event) => { if (event.key === "Enter") submitRename(); if (event.key === "Escape") { setTitle(session?.title ?? ""); setRenaming(false); } }} className="border-input bg-background focus:border-ring mx-1 h-6 min-w-0 flex-1 rounded-md border px-2 text-xs outline-none" aria-label={t("sidebar.renameSession")} /> : <ThreadListItemPrimitive.Trigger
        data-slot="aui_thread-list-item-trigger"
        className="focus-visible:ring-ring/50 text-foreground/95 group-hover:text-foreground group-data-active:text-foreground flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start outline-none transition-colors group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9 focus-visible:ring-1"
      >
        {isRunning && <MorphingSpinner data-slot="aui_thread-list-item-running" className="text-muted-foreground me-1.5" />}
        <span data-slot="aui_thread-list-item-title" className="min-w-0 flex-1 truncate">
          <ThreadListItemPrimitive.Title fallback="New Chat" />
        </span>
        {isRunning && <span className="sr-only">Running</span>}
      </ThreadListItemPrimitive.Trigger>}
      <ThreadListItemMore onRename={() => setRenaming(true)} onDelete={async () => { if (await confirmDestructiveAction(t("session.deleteConfirm", { title: session?.title ?? t("sidebar.newChat") }))) deleteSession(id); }} />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemMore: FC<{ onRename: () => void; onDelete: () => void | Promise<void> }> = ({ onRename, onDelete }) => {
  const { t } = useLocale();
  const id = useAuiState((s) => s.threadListItem.id);
  const priority = useSidebarPreferences((s) => s.priorityIds.includes(id));
  const togglePriority = useSidebarPreferences((s) => s.togglePriority);
  return (
    <ThreadListItemMorePrimitive.Root sharedFocusGroup>
      <ThreadListItemMorePrimitive.Trigger asChild>
        <Button
          variant="ghost"
          size="icon"
          data-slot="aui_thread-list-item-more"
          className="data-[state=open]:bg-accent absolute end-1.5 top-1/2 size-6 -translate-y-1/2 p-0 opacity-0 group-hover:opacity-100 group-has-focus-visible:opacity-100 group-data-active:opacity-100 data-[state=open]:opacity-100"
        >
          <MoreHorizontalIcon className="size-3.5" />
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
          <PinIcon className="size-4" />
          <span>{t(priority ? "sidebar.unpin" : "sidebar.pin")}</span>
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Item data-slot="aui_thread-list-item-more-item" onSelect={onRename} className="q-sidebar-menu-item">
          <PencilIcon className="size-4" />
          <span>{t("sidebar.rename")}</span>
        </ThreadListItemMorePrimitive.Item>
        <ThreadListItemMorePrimitive.Item data-slot="aui_thread-list-item-more-item" onSelect={onDelete} className="q-sidebar-menu-item q-sidebar-menu-item-danger">
          <TrashIcon className="size-4" />
          <span>{t("common.delete")}</span>
        </ThreadListItemMorePrimitive.Item>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
