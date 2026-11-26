import { useMemo, useState } from "react";
import {
  Laptop,
  Plus,
  Search,
  Trash2,
} from "lucide-react";
import type { ServerInfo } from "@qone/protocol";
import type { TeamBot, TeamGroup, TeamMessage } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { Button } from "../ui/Button";
import { CodexIcon, CodexServerIcon } from "../ui/CodexIcon";
import sidebarIcon from "../../assets/codex-icons/sidebar-light-16.svg";
import { TeamGroupAvatar } from "./TeamAvatar";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";
import { FadeScroll } from "../assistant-ui/elements/fade-scroll";

interface TeamSidebarProps {
  groups: readonly TeamGroup[];
  bots: readonly TeamBot[];
  activeGroupId?: string;
  messagesByGroup: Record<string, TeamMessage[]>;
  serversById: ReadonlyMap<string, ServerInfo>;
  onSelectGroup: (groupId: string) => void;
  onOpenCreateGroup: () => void;
  onDeleteGroup: (group: TeamGroup) => void;
  onCollapse: () => void;
}

export function TeamSidebar({
  groups,
  bots,
  activeGroupId,
  messagesByGroup,
  serversById,
  onSelectGroup,
  onOpenCreateGroup,
  onDeleteGroup,
  onCollapse,
}: TeamSidebarProps) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);

  const normalized = query.trim().toLocaleLowerCase();
  const filteredGroups = useMemo(() => {
    if (!normalized) return groups;
    return groups.filter((group) => {
      const memberNames = group.memberBotIds
        .map((id) => botsById.get(id)?.name ?? "")
        .join(" ");
      return `${group.name} ${group.description} ${memberNames}`
        .toLocaleLowerCase()
        .includes(normalized);
    });
  }, [groups, botsById, normalized]);

  return (
    <aside className="team-sidebar">
      <div className="team-sidebar-head">
        <TooltipIconButton
          tooltip={t("sidebar.collapse")}
          side="right"
          onClick={onCollapse}
          className="size-7 shrink-0"
        >
          <CodexIcon src={sidebarIcon} className="size-4" />
        </TooltipIconButton>
        <span className="team-sidebar-title truncate">{t("team.title")}</span>
        <div className="ml-auto flex items-center gap-1">
          <TooltipIconButton
            tooltip={t("team.newGroup")}
            onClick={onOpenCreateGroup}
            className="size-7"
          >
            <Plus size={15} />
          </TooltipIconButton>
        </div>
      </div>

      <div className="p-2.5 pb-2">
        <label className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("team.searchPlaceholder")}
            aria-label={t("team.searchPlaceholder")}
            className="h-8 w-full rounded-lg border border-border/70 bg-[var(--q-surface)] pr-2.5 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/30"
          />
        </label>
      </div>

      <FadeScroll className="flex-1 px-2.5 pb-3">
        <div className="flex flex-col gap-1">
          {filteredGroups.map((group) => {
            const members = group.memberBotIds
              .map((id) => botsById.get(id))
              .filter((bot): bot is TeamBot => Boolean(bot));
            const groupName = (group.directBotId && botsById.get(group.directBotId)?.name) || group.name;
            const groupMessages = messagesByGroup[group.id] ?? [];
            const latest = groupMessages[groupMessages.length - 1];
            const boundServers = group.execution.serverIds.filter((id) => serversById.has(id)).length;
            const isActive = group.id === activeGroupId;

            return (
              <div key={group.id} className="group/row relative">
                <button
                  type="button"
                  onClick={() => onSelectGroup(group.id)}
                  className={cn("team-group-item", isActive && "is-active")}
                >
                  <TeamGroupAvatar group={group} members={members} size={32} stackSize={26} />

                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1.5">
                      <strong className="truncate text-[13px] font-medium text-foreground">
                        {groupName}
                      </strong>
                      <span
                        className={cn(
                          "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                          boundServers > 0 && group.execution.strategy !== "local-only"
                            ? "bg-sky-500/12 text-sky-600 dark:text-sky-300"
                            : "bg-muted text-muted-foreground",
                        )}
                      >
                        {group.directBotId ? t("team.member.direct") : boundServers > 0 && group.execution.strategy !== "local-only" ? (
                          <>
                            <CodexServerIcon className="size-2.5" />
                            <span className="tabular-nums">{boundServers}</span>
                          </>
                        ) : (
                          <Laptop size={10} />
                        )}
                      </span>
                    </div>
                    <p className="mt-0.5 truncate text-[11.5px] text-muted-foreground">
                      {latest
                        ? latest.content
                        : group.directBotId ? members[0]?.roleTitle ?? t("team.member.unavailable")
                        : group.description || t("team.membersCount", { count: members.length })}
                    </p>
                  </div>
                </button>

                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDeleteGroup({ ...group, name: groupName });
                  }}
                  title={t("team.deleteGroup")}
                  aria-label={t("team.deleteGroup")}
                  className="absolute right-2 bottom-2 inline-flex size-6 items-center justify-center rounded-md bg-[var(--q-surface)]/95 text-muted-foreground opacity-0 shadow-xs transition-opacity hover:text-destructive group-hover/row:opacity-100"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            );
          })}

          {filteredGroups.length === 0 && (
            <div className="mt-6 flex flex-col items-center rounded-xl border border-dashed border-border px-4 py-6 text-center">
              <p className="text-xs font-medium text-foreground">{t("team.emptyGroupsTitle")}</p>
              <Button size="sm" className="mt-3 h-8 text-xs" onClick={onOpenCreateGroup}>
                <Plus size={13} />
                {t("team.newGroup")}
              </Button>
            </div>
          )}
        </div>
      </FadeScroll>
    </aside>
  );
}
