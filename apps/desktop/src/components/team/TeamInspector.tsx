import { useState } from "react";
import {
  Activity,
  Crown,
  Laptop,
  Pencil,
  Plus,
  Trash2,
  UserMinus,
  Users,
  X,
} from "lucide-react";
import type { ServerInfo } from "@qone/protocol";
import type { TeamBot, TeamGroup, TeamRunCard } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { CodexServerIcon } from "../ui/CodexIcon";
import { QoneSelect } from "../ui/Select";
import { SubagentLogo } from "../settings/subagent-logo";
import { FadeScroll } from "../assistant-ui/elements/fade-scroll";
import { AgentRunStatusCard } from "./AgentRunStatusCard";

interface TeamInspectorProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  allBots: readonly TeamBot[];
  botsById: ReadonlyMap<string, TeamBot>;
  serversById: ReadonlyMap<string, ServerInfo>;
  runs: readonly TeamRunCard[];
  onClose: () => void;
  onUpdateGroup: (patch: Partial<Omit<TeamGroup, "id" | "createdAt">>) => void;
  onAddMember: (botId: string) => void;
  onRemoveMember: (botId: string) => void;
  onEditBot: (bot: TeamBot) => void;
  onOpenCreateBot: () => void;
  onOpenServerPicker: () => void;
  onClearMessages: () => void;
  onRunAction: (runId: string, action: "pause" | "resume" | "cancel") => void;
}

export function TeamInspector({
  group,
  members,
  allBots,
  botsById,
  serversById,
  runs,
  onClose,
  onUpdateGroup,
  onAddMember,
  onRemoveMember,
  onEditBot,
  onOpenCreateBot,
  onOpenServerPicker,
  onClearMessages,
  onRunAction,
}: TeamInspectorProps) {
  const { t } = useLocale();
  const [tab, setTab] = useState<"overview" | "runs">("overview");
  const [addingMember, setAddingMember] = useState(false);

  const availableBots = allBots.filter((bot) => !group.memberBotIds.includes(bot.id));
  const boundServers = group.execution.serverIds
    .map((id) => serversById.get(id))
    .filter((server): server is ServerInfo => Boolean(server));

  return (
    <aside className="team-inspector">
      <div className="flex h-[54px] shrink-0 items-center justify-between border-b border-border/70 px-3.5">
        <div className="team-segmented flex-1">
          <button
            type="button"
            onClick={() => setTab("overview")}
            className={cn("team-segmented-btn", tab === "overview" && "is-active")}
          >
            <Users size={12} />
            <span>{t("team.inspector.overview")}</span>
          </button>
          <button
            type="button"
            onClick={() => setTab("runs")}
            className={cn("team-segmented-btn", tab === "runs" && "is-active")}
          >
            <Activity size={12} />
            <span>{t("team.inspector.runs")}</span>
            {runs.length > 0 && <span className="text-[10.5px] opacity-70 tabular-nums">{runs.length}</span>}
          </button>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("common.close")}
          className="ml-2 inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
        >
          <X size={14} />
        </button>
      </div>

      <FadeScroll className="flex-1 p-3.5">
        {tab === "overview" ? (
          <div className="flex flex-col gap-4">
            {/* 基本群信息 */}
            <section className="flex flex-col gap-2.5">
              <label className="flex flex-col gap-1 text-[11.5px] font-medium text-muted-foreground">
                <span>{t("team.inspector.groupName")}</span>
                <input
                  value={group.name}
                  onChange={(event) => onUpdateGroup({ name: event.target.value })}
                  className="h-8 rounded-lg border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-foreground/40"
                />
              </label>

              <label className="flex flex-col gap-1 text-[11.5px] font-medium text-muted-foreground">
                <span>{t("team.inspector.announcement")}</span>
                <textarea
                  rows={3}
                  value={group.announcement}
                  onChange={(event) => onUpdateGroup({ announcement: event.target.value })}
                  placeholder={t("team.inspector.announcementPlaceholder")}
                  className="resize-none rounded-lg border border-border bg-background p-2.5 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-foreground/40"
                />
              </label>

              <div className="flex flex-col gap-1">
                <span className="text-[11.5px] font-medium text-muted-foreground">
                  {t("team.inspector.coordinatorField")}
                </span>
                <QoneSelect
                  value={group.coordinatorBotId}
                  onChange={(coordinatorBotId) => onUpdateGroup({ coordinatorBotId })}
                  options={members.map((bot) => ({
                    value: bot.id,
                    label: bot.name,
                    description: bot.roleTitle,
                  }))}
                  ariaLabel={t("team.inspector.coordinatorField")}
                  triggerClassName="qone-select-trigger-compact w-full"
                />
              </div>

              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/75 bg-background px-2.5 py-2 text-xs">
                <span className="text-muted-foreground">{t("team.inspector.maxRounds")}</span>
                <input
                  type="number"
                  min={1}
                  max={20}
                  value={group.maxAutoRounds}
                  onChange={(event) =>
                    onUpdateGroup({
                      maxAutoRounds: Math.min(20, Math.max(1, Number(event.target.value) || 1)),
                    })
                  }
                  className="w-14 rounded-md border border-border bg-muted/40 px-2 py-0.5 text-right font-mono text-xs text-foreground outline-none tabular-nums"
                />
              </label>
            </section>

            {/* 群成员管理 */}
            <section className="border-t border-border/70 pt-3.5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("team.membersCount", { count: members.length })}
                </h3>
                <button
                  type="button"
                  onClick={() => setAddingMember((prev) => !prev)}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-accent"
                >
                  <Plus size={11} />
                  {t("team.addMember")}
                </button>
              </div>

              {addingMember && (
                <div className="mb-2.5 rounded-xl border border-border bg-background p-2">
                  <div className="flex max-h-40 flex-col gap-1 overflow-y-auto">
                    {availableBots.map((bot) => (
                      <button
                        key={bot.id}
                        type="button"
                        onClick={() => {
                          onAddMember(bot.id);
                          setAddingMember(false);
                        }}
                        className="flex items-center gap-2 rounded-lg px-2 py-1.5 text-left text-xs hover:bg-accent"
                      >
                        <SubagentLogo logo={bot.logo} name={bot.name} size={22} />
                        <span className="min-w-0 flex-1 truncate font-medium text-foreground">{bot.name}</span>
                        <span className="truncate text-[10.5px] text-muted-foreground">{bot.roleTitle}</span>
                      </button>
                    ))}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setAddingMember(false);
                      onOpenCreateBot();
                    }}
                    className="mt-1.5 flex w-full items-center justify-center gap-1 rounded-lg border border-dashed border-border py-1.5 text-[11.5px] text-muted-foreground hover:border-foreground/30 hover:text-foreground"
                  >
                    <Plus size={12} />
                    {t("team.newBot")}
                  </button>
                </div>
              )}

              <div className="flex flex-col gap-1.5">
                {members.map((bot) => {
                  const isCoordinator = bot.id === group.coordinatorBotId;
                  return (
                    <div
                      key={bot.id}
                      className="group/member flex items-center gap-2.5 rounded-xl border border-border/65 bg-background px-2.5 py-2"
                    >
                      <SubagentLogo logo={bot.logo} name={bot.name} size={26} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1">
                          <strong className="truncate text-xs font-medium text-foreground">{bot.name}</strong>
                          {isCoordinator && <Crown size={11} className="shrink-0 text-amber-500" />}
                        </div>
                        <div className="truncate text-[10.5px] text-muted-foreground">{bot.roleTitle}</div>
                      </div>
                      <div className="flex items-center gap-0.5 opacity-0 transition-opacity group-hover/member:opacity-100">
                        <button
                          type="button"
                          onClick={() => onEditBot(bot)}
                          title={t("team.editBot")}
                          aria-label={t("team.editBot")}
                          className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                        >
                          <Pencil size={12} />
                        </button>
                        {members.length > 1 && (
                          <button
                            type="button"
                            onClick={() => onRemoveMember(bot.id)}
                            title={t("team.removeMember")}
                            aria-label={t("team.removeMember")}
                            className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                          >
                            <UserMinus size={12} />
                          </button>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>

            {/* 执行环境概览 */}
            <section className="border-t border-border/70 pt-3.5">
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-foreground">{t("team.env.title")}</h3>
                <button
                  type="button"
                  onClick={onOpenServerPicker}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-border bg-background px-2 text-[11px] font-medium text-foreground hover:bg-accent"
                >
                  <CodexServerIcon className="size-3" />
                  {t("team.env.manageServers")}
                </button>
              </div>

              <div className="flex flex-col gap-1.5 rounded-xl border border-border/75 bg-background p-2.5 text-xs">
                <div className="flex items-center gap-2">
                  <Laptop size={13} className="text-emerald-500" />
                  <span className="font-medium text-foreground">{t("team.env.local")}</span>
                  <span className="ml-auto rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                    {group.execution.allowLocal || boundServers.length === 0
                      ? t("team.presence.idle")
                      : t("team.env.serversPreferred")}
                  </span>
                </div>

                {boundServers.map((server) => (
                  <div
                    key={server.id}
                    className="flex items-center gap-2 border-t border-border/55 pt-1.5"
                  >
                    <CodexServerIcon className="size-3.5 text-sky-600 dark:text-sky-300" />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium text-foreground">{server.name}</div>
                      <div className="truncate text-[10.5px] text-muted-foreground">
                        {server.username}@{server.host}
                      </div>
                    </div>
                    <span
                      className={cn(
                        "size-2 rounded-full",
                        server.status === "ready" ? "bg-emerald-500" : "bg-muted-foreground/40",
                      )}
                    />
                  </div>
                ))}
              </div>
            </section>

            {/* 危险操作 */}
            <section className="border-t border-border/70 pt-3">
              <button
                type="button"
                onClick={onClearMessages}
                className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border bg-background py-2 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
              >
                <Trash2 size={13} />
                {t("team.clearMessages")}
              </button>
            </section>
          </div>
        ) : (
          <div className="flex flex-col gap-2.5">
            {runs.length === 0 ? (
              <p className="py-10 text-center text-xs text-muted-foreground">
                {t("team.inspector.noRuns")}
              </p>
            ) : (
              [...runs]
                .reverse()
                .map((run) => (
                  <AgentRunStatusCard
                    key={run.id}
                    run={run}
                    botsById={botsById}
                    serversById={serversById}
                    compact
                    defaultOpen={false}
                    onAction={(action) => onRunAction(run.id, action)}
                  />
                ))
            )}
          </div>
        )}
      </FadeScroll>
    </aside>
  );
}
