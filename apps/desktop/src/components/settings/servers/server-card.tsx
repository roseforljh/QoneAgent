import { ContextMenu, DropdownMenu } from "radix-ui";
import { ChevronRightIcon } from "lucide-react";
import type { ReactNode } from "react";
import type { ServerGroupInfo, ServerInfo } from "@qone/protocol";
import { cn } from "../../../lib/utils";
import { useLocale } from "../../../localization";
import { openContextMenuFromKeyboard } from "../../../lib/context-menu";
import { CodexIcon } from "../../ui/CodexIcon";
import terminalIcon from "../../../assets/codex-icons/terminal-light-16.svg";
import moreIcon from "../../../assets/codex-icons/ellipsis-horizontal-light-16.svg";
import trashIcon from "../../../assets/codex-icons/trash-light-16.svg";
import pencilIcon from "../../../assets/codex-icons/pencil-light-16.svg";
import folderIcon from "../../../assets/codex-icons/folder-light-16.svg";
import refreshIcon from "../../../assets/codex-icons/arrows-clockwise-rotate-lg-light-16.svg";
import copyIcon from "../../../assets/codex-icons/square-on-square-light-16.svg";
import plusIcon from "../../../assets/codex-icons/plus-md-light-16.svg";

export const SERVER_DRAG_TYPE = "application/x-qone-server";

export const serverAddress = (server: Pick<ServerInfo, "username" | "host" | "port">) =>
  `${server.username}@${server.host}${server.port === 22 ? "" : `:${server.port}`}`;

export interface ServerActions {
  open: (server: ServerInfo) => void;
  terminal: (server: ServerInfo) => void;
  test: (server: ServerInfo) => void;
  move: (server: ServerInfo, groupId?: string) => void;
  moveToNewGroup: (server: ServerInfo) => void;
  remove: (server: ServerInfo) => void;
}

/** One item tree for both the hover menu and the right-click menu. */
function ServerMenuItems({ menu: M, server, groups, actions }: { menu: typeof DropdownMenu; server: ServerInfo; groups: ServerGroupInfo[]; actions: ServerActions }) {
  const { t } = useLocale();
  const item = (icon: string, label: string, onSelect: () => void, danger = false) => (
    <M.Item className={cn("q-sidebar-menu-item", danger && "servers-menu-danger")} onSelect={onSelect}>
      <CodexIcon src={icon} className="size-4" />{label}
    </M.Item>
  );
  return <>
    {item(terminalIcon, t("servers.openTerminal"), () => actions.terminal(server))}
    {item(refreshIcon, t("servers.test"), () => actions.test(server))}
    {item(copyIcon, t("servers.copyAddress"), () => void navigator.clipboard.writeText(serverAddress(server)))}
    <M.Sub>
      <M.SubTrigger className="q-sidebar-menu-item q-sidebar-menu-subtrigger">
        <CodexIcon src={folderIcon} className="size-4" />{t("servers.moveTo")}<ChevronRightIcon className="size-3.5" />
      </M.SubTrigger>
      <M.Portal>
        <M.SubContent className="q-sidebar-menu q-sidebar-submenu servers-menu" sideOffset={4} alignOffset={-4} collisionPadding={8}>
          <M.RadioGroup value={server.groupId ?? ""} onValueChange={(value) => actions.move(server, value || undefined)}>
            {[{ id: "", name: t("servers.ungrouped") }, ...groups].map((group) => (
              <M.RadioItem key={group.id} value={group.id} className="q-sidebar-menu-item">
                <span className="q-sidebar-menu-radio"><M.ItemIndicator /></span>{group.name}
              </M.RadioItem>
            ))}
          </M.RadioGroup>
          <M.Separator className="servers-menu-separator" />
          {item(plusIcon, t("servers.newGroup"), () => actions.moveToNewGroup(server))}
        </M.SubContent>
      </M.Portal>
    </M.Sub>
    <M.Separator className="servers-menu-separator" />
    {item(trashIcon, t("servers.delete"), () => actions.remove(server), true)}
  </>;
}

export function ServerCard({ server, groups, tunnels, actions, dragging, onDragState }: {
  server: ServerInfo; groups: ServerGroupInfo[]; tunnels: number; actions: ServerActions;
  dragging: boolean; onDragState: (id?: string) => void;
}) {
  const { t } = useLocale();
  const auth = server.auth.kind === "agent" ? "SSH Agent" : server.auth.dedicated ? t("servers.authDedicated") : t("servers.authLocalKey");
  return (
    <ContextMenu.Root>
      <ContextMenu.Trigger asChild onKeyDown={openContextMenuFromKeyboard}>
        <article
          className={cn("server-card", `is-${server.status}`, dragging && "is-dragging")}
          tabIndex={0}
          draggable
          onDragStart={(event) => { event.dataTransfer.setData(SERVER_DRAG_TYPE, server.id); event.dataTransfer.effectAllowed = "move"; onDragState(server.id); }}
          onDragEnd={() => onDragState(undefined)}
          onClick={() => actions.open(server)}
          onKeyDown={(event) => { if (event.key === "Enter") actions.open(server); }}
          aria-label={`${server.name}, ${t(`servers.status.${server.status}`)}`}
        >
          <header>
            <span className={cn("servers-dot", `is-${server.status}`)} title={t(`servers.status.${server.status}`)} />
            <strong>{server.name}</strong>
            <span className="server-card-actions" onClick={(event) => event.stopPropagation()}>
              <button type="button" className="servers-icon-button" disabled={server.status === "host-key-changed"} onClick={() => actions.terminal(server)} aria-label={t("servers.openTerminal")} title={t("servers.openTerminal")}>
                <CodexIcon src={terminalIcon} className="size-4" />
              </button>
              <DropdownMenu.Root>
                <DropdownMenu.Trigger asChild>
                  <button type="button" className="servers-icon-button" aria-label={t("servers.more")}><CodexIcon src={moreIcon} className="size-4" /></button>
                </DropdownMenu.Trigger>
                <DropdownMenu.Portal>
                  <DropdownMenu.Content className="q-sidebar-menu servers-menu" align="end" sideOffset={6} collisionPadding={8}>
                    <ServerMenuItems menu={DropdownMenu} server={server} groups={groups} actions={actions} />
                  </DropdownMenu.Content>
                </DropdownMenu.Portal>
              </DropdownMenu.Root>
            </span>
          </header>
          <p className="server-card-address">{serverAddress(server)}</p>
          <p className="server-card-system">{server.status === "ready" ? server.system ?? "—" : t(`servers.status.${server.status}`)}</p>
          <footer>
            <span className="server-chip">{auth}</span>
            {tunnels > 0 && <span className="server-chip is-accent">{t("servers.tunnelCount", { count: tunnels })}</span>}
          </footer>
        </article>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="q-sidebar-menu servers-menu" collisionPadding={8}>
          <ServerMenuItems menu={ContextMenu as unknown as typeof DropdownMenu} server={server} groups={groups} actions={actions} />
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

/** Rename and delete for a group header; same items on hover and right-click. */
export function GroupMenu({ children, onRename, onDelete }: { children: ReactNode; onRename: () => void; onDelete: () => void }) {
  const { t } = useLocale();
  return (
    <DropdownMenu.Root>
      <DropdownMenu.Trigger asChild>{children}</DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content className="q-sidebar-menu servers-menu" align="end" sideOffset={6} collisionPadding={8}>
          <DropdownMenu.Item className="q-sidebar-menu-item" onSelect={onRename}><CodexIcon src={pencilIcon} className="size-4" />{t("servers.renameGroup")}</DropdownMenu.Item>
          <DropdownMenu.Item className="q-sidebar-menu-item servers-menu-danger" onSelect={onDelete}><CodexIcon src={trashIcon} className="size-4" />{t("servers.deleteGroup")}</DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
