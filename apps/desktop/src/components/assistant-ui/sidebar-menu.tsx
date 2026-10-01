import { ContextMenu, DropdownMenu } from "radix-ui";
import { ChevronRightIcon } from "lucide-react";
import { CodexIcon } from "../ui/CodexIcon";
import moreIcon from "../../assets/codex-icons/ellipsis-horizontal-light-16.svg";
import plusIcon from "../../assets/codex-icons/plus-md-light-16.svg";
import pinIcon from "../../assets/codex-icons/pin-light-16.svg";
import pinOffIcon from "../../assets/codex-icons/pin-slash-light-16.svg";
import pencilIcon from "../../assets/codex-icons/pencil-light-16.svg";
import trashIcon from "../../assets/codex-icons/trash-light-16.svg";
import { useStore } from "../../store";
import { useLocale, type MessageKey } from "../../localization";
import { useSidebarPreferences, type ChatSort, type SidebarLayout } from "../../lib/sidebar-preferences";
import "./sidebar-menu.css";
import { cn } from "../../lib/utils";
import { openContextMenuFromKeyboard } from "../../lib/context-menu";
import type { ReactElement } from "react";

const layouts: { value: SidebarLayout; label: MessageKey }[] = [
  { value: "project", label: "sidebar.byProject" },
  { value: "list", label: "sidebar.byList" },
];
const sorts: { value: ChatSort; label: MessageKey }[] = [
  { value: "priority", label: "sidebar.priority" },
  { value: "recent", label: "sidebar.recent" },
  { value: "manual", label: "sidebar.manual" },
];

export function SidebarMenu({ trigger = "plus", onOpenChange }: { trigger?: "plus" | "more"; onOpenChange?: (open: boolean) => void }) {
  const { t } = useLocale();
  const { layout, sort, setLayout, setSort } = useSidebarPreferences();
  return (
    <DropdownMenu.Root onOpenChange={onOpenChange}>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="q-sidebar-menu-trigger text-muted-foreground hover:text-foreground grid size-6 cursor-pointer place-items-center rounded-md" aria-label={t("sidebar.options")}>
          <CodexIcon src={trigger === "plus" ? plusIcon : moreIcon} className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="q-sidebar-menu" side="bottom" align="start" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="q-sidebar-menu-item q-sidebar-menu-subtrigger">
              {t("sidebar.organize")}<ChevronRightIcon className="size-3.5" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="q-sidebar-menu q-sidebar-submenu" sideOffset={4} alignOffset={-4} collisionPadding={8}>
                <DropdownMenu.RadioGroup value={layout} onValueChange={(value) => setLayout(value as SidebarLayout)} aria-label={t("sidebar.organize")}>
                  {layouts.map((option) => <DropdownMenu.RadioItem key={option.value} value={option.value} className="q-sidebar-menu-item">
                    <span className="q-sidebar-menu-radio"><DropdownMenu.ItemIndicator /></span>{t(option.label)}
                  </DropdownMenu.RadioItem>)}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
          <DropdownMenu.Sub>
            <DropdownMenu.SubTrigger className="q-sidebar-menu-item q-sidebar-menu-subtrigger">
              {t("sidebar.sort")}<ChevronRightIcon className="size-3.5" />
            </DropdownMenu.SubTrigger>
            <DropdownMenu.Portal>
              <DropdownMenu.SubContent className="q-sidebar-menu q-sidebar-submenu" sideOffset={4} alignOffset={-4} collisionPadding={8}>
                <DropdownMenu.RadioGroup value={sort} onValueChange={(value) => setSort(value as ChatSort, useStore.getState().sessions)} aria-label={t("sidebar.sort")}>
                  {sorts.map((option) => <DropdownMenu.RadioItem key={option.value} value={option.value} className="q-sidebar-menu-item">
                    <span className="q-sidebar-menu-radio"><DropdownMenu.ItemIndicator /></span>{t(option.label)}
                  </DropdownMenu.RadioItem>)}
                </DropdownMenu.RadioGroup>
              </DropdownMenu.SubContent>
            </DropdownMenu.Portal>
          </DropdownMenu.Sub>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

export function SidebarEntityMenu({
  pinned,
  onTogglePinned,
  onRename,
  onDelete,
  ariaLabel,
  side = "right",
  align = "start",
  triggerClassName,
}: {
  pinned: boolean;
  onTogglePinned: () => void;
  onRename: () => void;
  onDelete: () => void | Promise<void>;
  ariaLabel: string;
  side?: "top" | "right" | "bottom" | "left";
  align?: "start" | "center" | "end";
  triggerClassName?: string;
}) {
  const { t } = useLocale();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className={cn("q-sidebar-menu-trigger text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded-md", triggerClassName)} aria-label={ariaLabel}>
          <CodexIcon src={moreIcon} className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="q-sidebar-menu" side={side} align={align} sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onTogglePinned}>
            <CodexIcon src={pinned ? pinOffIcon : pinIcon} className="size-4" />
            <span>{t(pinned ? "sidebar.unpin" : "sidebar.pin")}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onRename}>
            <CodexIcon src={pencilIcon} className="size-4" />
            <span>{t("sidebar.rename")}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border/60 dark:bg-white/10" />
          <DropdownMenu.Item className="q-sidebar-menu-item q-sidebar-menu-item-danger" onSelect={onDelete}>
            <CodexIcon src={trashIcon} className="size-4" />
            <span>{t("common.delete")}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

/** Row gestures reuse the same callbacks as the visible overflow button. */
export function SidebarContextMenu({
  children,
  pinned,
  onTogglePinned,
  onRename,
  onDelete,
  onNewChat,
  newChatLabel,
  disabled = false,
}: {
  children: ReactElement;
  pinned: boolean;
  onTogglePinned: () => void;
  onRename: () => void;
  onDelete: () => void | Promise<void>;
  onNewChat?: () => void;
  newChatLabel?: string;
  disabled?: boolean;
}) {
  const { t } = useLocale();
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild disabled={disabled} onKeyDown={disabled ? undefined : openContextMenuFromKeyboard} data-sidebar-context-menu-trigger>
        {children}
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="q-sidebar-menu" data-sidebar-context-menu>
          {onNewChat && <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onNewChat}>
            <CodexIcon src={plusIcon} className="size-4" />
            <span>{newChatLabel ?? t("sidebar.newChat")}</span>
          </ContextMenu.Item>}
          <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onTogglePinned}>
            <CodexIcon src={pinned ? pinOffIcon : pinIcon} className="size-4" />
            <span>{t(pinned ? "sidebar.unpin" : "sidebar.pin")}</span>
          </ContextMenu.Item>
          <ContextMenu.Item className="q-sidebar-menu-item" onSelect={onRename}>
            <CodexIcon src={pencilIcon} className="size-4" />
            <span>{t("sidebar.rename")}</span>
          </ContextMenu.Item>
          <ContextMenu.Separator className="my-1 h-px bg-border/60 dark:bg-white/10" />
          <ContextMenu.Item className="q-sidebar-menu-item q-sidebar-menu-item-danger" onSelect={onDelete}>
            <CodexIcon src={trashIcon} className="size-4" />
            <span>{t("common.delete")}</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
