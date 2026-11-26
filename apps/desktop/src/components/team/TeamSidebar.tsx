import { useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import {
  ArrowLeft,
  Bot,
  Laptop,
  MessagesSquare,
  Pencil,
  Plus,
  Search,
  Trash2,
  UserPlus,
} from "lucide-react";
import type { ServerInfo } from "@qone/protocol";
import type { TeamBot, TeamGroup, TeamMessage } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { Button } from "../ui/Button";
import { CodexServerIcon } from "../ui/CodexIcon";
import { SubagentLogo } from "../settings/subagent-logo";
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
  onOpenCreateBot: () => void;
  onEditBot: (bot: TeamBot) => void;
  onDeleteBot: (bot: TeamBot) => void;
  onDeleteGroup: (group: TeamGroup) => void;
  onAddBotToActiveGroup: (botId: string) => void;
}

export function TeamSidebar({
  groups,
  bots,
  activeGroupId,
  messagesByGroup,
  serversById,
  onSelectGroup,
  onOpenCreateGroup,
  onOpenCreateBot,
  onEditBot,
  onDeleteBot,
  onDeleteGroup,
  onAddBotToActiveGroup,
}: TeamSidebarProps) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"groups" | "bots">("groups");
  const [query, setQuery] = useState("");
  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId),
    [groups, activeGroupId],
  );

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

  const filteredBots = useMemo(() => {
    if (!normalized) return bots;
    return bots.filter((bot) =>
      `${bot.name} ${bot.roleTitle} ${bot.description} ${bot.capabilities.join(" ")}`
        .toLocaleLowerCase()
        .includes(normalized),
    );
  }, [bots, normalized]);

  return (
    <aside className="team-sidebar">
      <div className="team-sidebar-head">
        <Link
          to="/"
          className="page-back-link page-back-link-icon"
          title={t("app.backHome")}
          aria-label={t("app.backHome")}
        >
          <ArrowLeft size={16} />
        </Link>
        <span className="team-sidebar-title truncate">{t("team.title")}</span>
        <div className="ml-auto flex items-center gap-1">
          <TooltipIconButton
            tooltip={tab === "groups" ? t("team.newGroup") : t("team.newBot")}
            onClick={tab === "groups" ? onOpenCreateGroup : onOpenCreateBot}
            className="size-7"
          >
            <Plus size={15} />
          </TooltipIconButton>
        </div>
      </div>

      <div className="flex flex-col gap-2.5 p-3 pb-2">
        <div className="team-segmented" role="tablist" aria-label={t("team.title")}>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "groups"}
            className={cn("team-segmented-btn", tab === "groups" && "is-active")}
            onClick={() => setTab("groups")}
          >
            <MessagesSquare size={13} />
            <span>{t("team.tabs.groups")}</span>
            <span className="text-[11px] opacity-65 tabular-nums">{groups.length}</span>
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={tab === "bots"}
            className={cn("team-segmented-btn", tab === "bots" && "is-active")}
            onClick={() => setTab("bots")}
          >
            <Bot size={13} />
            <span>{t("team.tabs.bots")}</span>
            <span className="text-[11px] opacity-65 tabular-nums">{bots.length}</span>
          </button>
        </div>

        <label className="relative flex items-center">
          <Search size={13} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder={t("team.searchPlaceholder")}
            aria-label={t("team.searchPlaceholder")}
            className="h-8 w-full rounded-lg border border-border/80 bg-background pr-2.5 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/35"
          />
        </label>
      </div>

      <FadeScroll className="flex-1 px-2.5 pb-3">
        {tab === "groups" ? (
          <div className="flex flex-col gap-1">
            {filteredGroups.map((group) => {
              const members = group.memberBotIds
                .map((id) => botsById.get(id))
                .filter((bot): bot is TeamBot => Boolean(bot));
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
                    <div className="team-avatar-stack">
                      {members.slice(0, 3).map((member) => (
                        <SubagentLogo key={member.id} logo={member.logo} name={member.name} size={26} />
                      ))}
                    </div>

                    <div className="min-w-0 flex-1">
                      <div className="flex items-center justify-between gap-1.5">
                        <strong className="truncate text-[13px] font-medium text-foreground">
                          {group.name}
                        </strong>
                        <span
                          className={cn(
                            "inline-flex shrink-0 items-center gap-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-medium",
                            boundServers > 0 && group.execution.strategy !== "local-only"
                              ? "bg-sky-500/12 text-sky-600 dark:text-sky-300"
                              : "bg-muted text-muted-foreground",
                          )}
                        >
                          {boundServers > 0 && group.execution.strategy !== "local-only" ? (
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
                          : group.description || t("team.membersCount", { count: members.length })}
                      </p>
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      onDeleteGroup(group);
                    }}
                    title={t("team.deleteGroup")}
                    aria-label={t("team.deleteGroup")}
                    className="absolute right-2 bottom-2 inline-flex size-6 items-center justify-center rounded-md bg-background/90 text-muted-foreground opacity-0 shadow-xs transition-opacity hover:text-destructive group-hover/row:opacity-100"
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
        ) : (
          <div className="flex flex-col gap-1.5">
            {filteredBots.map((bot) => {
              const inActiveGroup = Boolean(activeGroup?.memberBotIds.includes(bot.id));
              return (
                <div
                  key={bot.id}
                  className="group/bot flex items-start gap-2.5 rounded-xl border border-border/65 bg-background p-2.5 transition-colors hover:border-border"
                >
                  <SubagentLogo logo={bot.logo} name={bot.name} size={30} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-1.5">
                      <strong className="truncate text-[13px] font-medium text-foreground">{bot.name}</strong>
                      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                        {t(`team.source.${bot.source}` as Parameters<typeof t>[0])}
                      </span>
                    </div>
                    <div className="truncate text-[11px] text-muted-foreground">{bot.roleTitle}</div>
                    {bot.description && (
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground/90">
                        {bot.description}
                      </p>
                    )}
                    <div className="mt-2 flex items-center gap-1.5">
                      {activeGroup && (
                        <button
                          type="button"
                          disabled={inActiveGroup}
                          onClick={() => onAddBotToActiveGroup(bot.id)}
                          className={cn(
                            "inline-flex h-6 items-center gap-1 rounded-md border px-2 text-[11px] font-medium transition-colors",
                            inActiveGroup
                              ? "border-transparent bg-muted text-muted-foreground"
                              : "border-border bg-background text-foreground hover:bg-accent",
                          )}
                        >
                          <UserPlus size={11} />
                          {t(inActiveGroup ? "team.inCurrentGroup" : "team.inviteToGroup")}
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => onEditBot(bot)}
                        title={t("team.editBot")}
                        aria-label={t("team.editBot")}
                        className="ml-auto inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Pencil size={12} />
                      </button>
                      {bot.source === "custom" && (
                        <button
                          type="button"
                          onClick={() => onDeleteBot(bot)}
                          title={t("team.deleteBot")}
                          aria-label={t("team.deleteBot")}
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {filteredBots.length === 0 && (
              <p className="py-8 text-center text-xs text-muted-foreground">{t("team.emptyBotsTitle")}</p>
            )}
          </div>
        )}
      </FadeScroll>

      <div className="border-t border-border/60 p-2.5">
        <div className="grid grid-cols-2 gap-1.5">
          <Button variant="outline" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={onOpenCreateGroup}>
            <Plus size={13} />
            {t("team.newGroup")}
          </Button>
          <Button variant="secondary" size="sm" className="h-8 gap-1.5 px-2 text-xs" onClick={onOpenCreateBot}>
            <Bot size={13} />
            {t("team.newBot")}
          </Button>
        </div>
      </div>
    </aside>
  );
}
