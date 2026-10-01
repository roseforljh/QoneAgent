import { DropdownMenu } from "radix-ui";
import { useLocale } from "../../localization";
import { CodexIcon } from "../ui/CodexIcon";
import { TooltipIconButton } from "./tooltip-icon-button";
import moreIcon from "../../assets/codex-icons/ellipsis-horizontal-light-16.svg";
import trashIcon from "../../assets/codex-icons/trash-light-16.svg";
import restartIcon from "../../assets/codex-icons/arrows-clockwise-rotate-lg-light-16.svg";
import "./sidebar-menu.css";

export function DockTerminalActions({ onClear, onRestart }: { onClear: () => void; onRestart: () => void }) {
  const { t } = useLocale();
  return <DropdownMenu.Root>
    <DropdownMenu.Trigger asChild>
      <TooltipIconButton tooltip={t("dock.more")} className="size-7">
        <CodexIcon src={moreIcon} className="size-4" />
      </TooltipIconButton>
    </DropdownMenu.Trigger>
    <DropdownMenu.Portal>
      <DropdownMenu.Content className="q-sidebar-menu" align="end" sideOffset={6} collisionPadding={8}>
        <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onClear}>
          <CodexIcon src={trashIcon} className="size-4" />{t("dock.terminalClear")}
        </DropdownMenu.Item>
        <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onRestart}>
          <CodexIcon src={restartIcon} className="size-4" />{t("dock.terminalRestart")}
        </DropdownMenu.Item>
      </DropdownMenu.Content>
    </DropdownMenu.Portal>
  </DropdownMenu.Root>;
}
