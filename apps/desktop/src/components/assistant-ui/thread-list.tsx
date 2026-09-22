import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import {
  AuiIf,
  ThreadListItemMorePrimitive,
  ThreadListItemPrimitive,
  ThreadListPrimitive,
  useAuiState,
} from "@assistant-ui/react";
import { Loader2Icon, MoreHorizontalIcon, PlusIcon, TrashIcon } from "lucide-react";
import { Fragment, forwardRef, useMemo, type ComponentPropsWithoutRef, type FC } from "react";

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

const dateGroupLabel = (date: Date | undefined, startOfToday: number): string => {
  if (!date || date.getTime() >= startOfToday) return "Today";
  if (date.getTime() >= startOfToday - DAY_IN_MS) return "Yesterday";
  return "Earlier";
};

const ThreadListItemGroups: FC = () => {
  const threadIds = useAuiState((s) => s.threads.threadIds);
  const threadItems = useAuiState((s) => s.threads.threadItems);

  const groups = useMemo(() => {
    const itemsById = new Map(threadItems.map((item) => [item.id, item]));
    const dates = threadIds.map((id) => itemsById.get(id)?.lastMessageAt);
    if (!dates.some(Boolean)) return null;
    const now = new Date();
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const time = (index: number) => dates[index]?.getTime() ?? Number.MAX_SAFE_INTEGER;
    const sorted = threadIds.map((_, index) => index).sort((a, b) => time(b) - time(a));
    const result: { label: string; indices: number[] }[] = [];
    for (const index of sorted) {
      const label = dateGroupLabel(dates[index], startOfToday);
      const lastGroup = result[result.length - 1];
      if (lastGroup?.label === label) lastGroup.indices.push(index);
      else result.push({ label, indices: [index] });
    }
    return result;
  }, [threadIds, threadItems]);

  if (!groups) {
    return threadIds.map((id, index) => (
      <ThreadListPrimitive.ItemByIndex key={id} index={index} components={{ ThreadListItem }} />
    ));
  }

  return groups.map((group) => (
    <Fragment key={group.label}>
      <div data-slot="aui_thread-list-group-label" className="text-muted-foreground px-2.5 pt-3 pb-1 text-xs font-medium">
        {group.label}
      </div>
      {group.indices.map((index) => (
        <ThreadListPrimitive.ItemByIndex key={threadIds[index]} index={index} components={{ ThreadListItem }} />
      ))}
    </Fragment>
  ));
};

export const ThreadListNew = forwardRef<HTMLButtonElement, ComponentPropsWithoutRef<typeof Button> & { labelClassName?: string }>(
  ({ className, labelClassName, children, ...props }, ref) => {
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
              <span data-slot="aui_thread-list-new-label" className={cn("whitespace-nowrap", labelClassName)}>新建会话</span>
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

  return (
    <ThreadListItemPrimitive.Root
      data-slot="aui_thread-list-item"
      className="group hover:bg-muted focus-visible:bg-muted data-active:bg-muted has-focus-visible:bg-muted has-data-[state=open]:bg-muted relative flex h-8 items-center rounded-md transition-colors focus-visible:outline-none"
    >
      <ThreadListItemPrimitive.Trigger
        data-slot="aui_thread-list-item-trigger"
        className="focus-visible:ring-ring/50 text-foreground/95 group-hover:text-foreground group-data-active:text-foreground flex h-full min-w-0 flex-1 items-center rounded-md px-2.5 text-start outline-none transition-colors group-hover:pe-9 group-has-focus-visible:pe-9 group-has-data-[state=open]:pe-9 group-data-active:pe-9 focus-visible:ring-1"
      >
        {isRunning && <Loader2Icon aria-hidden data-slot="aui_thread-list-item-running" className="text-muted-foreground me-1.5 size-3.5 shrink-0 animate-spin" />}
        <span data-slot="aui_thread-list-item-title" className="min-w-0 flex-1 truncate">
          <ThreadListItemPrimitive.Title fallback="New Chat" />
        </span>
        {isRunning && <span className="sr-only">Running</span>}
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemMore />
    </ThreadListItemPrimitive.Root>
  );
};

const ThreadListItemMore: FC = () => {
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
          <span className="sr-only">More options</span>
        </Button>
      </ThreadListItemMorePrimitive.Trigger>
      <ThreadListItemMorePrimitive.Content
        side="right"
        align="start"
        sideOffset={6}
        data-slot="aui_thread-list-item-more-content"
        className="bg-popover text-popover-foreground data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95 data-[state=open]:animate-in z-50 min-w-32 overflow-hidden rounded-xl border p-1.5"
      >
        <ThreadListItemPrimitive.Delete asChild>
          <ThreadListItemMorePrimitive.Item
            data-slot="aui_thread-list-item-more-item"
            className="text-destructive hover:bg-destructive/10 hover:text-destructive focus:bg-destructive/10 focus:text-destructive flex cursor-pointer items-center gap-2 rounded-lg px-2.5 py-1.5 text-sm outline-none select-none"
          >
            <TrashIcon className="size-4" />
            Delete
          </ThreadListItemMorePrimitive.Item>
        </ThreadListItemPrimitive.Delete>
      </ThreadListItemMorePrimitive.Content>
    </ThreadListItemMorePrimitive.Root>
  );
};
