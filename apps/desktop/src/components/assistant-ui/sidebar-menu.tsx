import { DropdownMenu } from "radix-ui";
import { ChevronRightIcon, MoreHorizontalIcon, PencilIcon, PinIcon, PinOffIcon, PlusIcon, TrashIcon } from "lucide-react";
import { useStore } from "../../store";
import { useLocale, type MessageKey } from "../../localization";
import { useSidebarPreferences, type ChatSort, type SidebarLayout } from "../../lib/sidebar-preferences";
import "./sidebar-menu.css";

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
          {trigger === "plus" ? <PlusIcon className="size-3.5" /> : <MoreHorizontalIcon className="size-3.5" />}
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
}: {
  pinned: boolean;
  onTogglePinned: () => void;
  onRename: () => void;
  onDelete: () => void | Promise<void>;
  ariaLabel: string;
}) {
  const { t } = useLocale();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>
        <button type="button" className="q-sidebar-menu-trigger text-muted-foreground hover:text-foreground grid size-6 place-items-center rounded-md" aria-label={ariaLabel}>
          <MoreHorizontalIcon className="size-3.5" />
        </button>
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="q-sidebar-menu" side="right" align="start" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onTogglePinned}>
            {pinned ? <PinOffIcon className="size-4" /> : <PinIcon className="size-4" />}
            <span>{t(pinned ? "sidebar.unpin" : "sidebar.pin")}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onRename}>
            <PencilIcon className="size-4" />
            <span>{t("sidebar.rename")}</span>
          </DropdownMenu.Item>
          <DropdownMenu.Separator className="my-1 h-px bg-border/60 dark:bg-white/10" />
          <DropdownMenu.Item className="q-sidebar-menu-item q-sidebar-menu-item-danger" onSelect={onDelete}>
            <TrashIcon className="size-4" />
            <span>{t("common.delete")}</span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
