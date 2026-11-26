import { useState } from "react";
import { Popover } from "radix-ui";
import {
  Check,
  Crown,
  Laptop,
  PanelRight,
  Plus,
  Sparkles,
} from "lucide-react";
import type { ServerInfo, WorkspaceInfo } from "@qone/protocol";
import type {
  TeamBot,
  TeamBotPresence,
  TeamChatMode,
  TeamExecutionStrategy,
  TeamGroup,
} from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { CodexServerIcon } from "../ui/CodexIcon";
import { QoneSelect } from "../ui/Select";
import { SubagentLogo } from "../settings/subagent-logo";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";

interface TeamChatHeaderProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  presence: Record<string, TeamBotPresence>;
  servers: readonly ServerInfo[];
  workspaces: readonly WorkspaceInfo[];
  inspectorOpen: boolean;
  onToggleInspector: () => void;
  onUpdateGroup: (patch: Partial<Omit<TeamGroup, "id" | "createdAt">>) => void;
  onOpenServerPicker: () => void;
  onMentionBot: (bot: TeamBot) => void;
  onOpenAddMember: () => void;
}

const STRATEGIES: ReadonlyArray<{
  id: TeamExecutionStrategy;
  titleKey: "team.env.smart" | "team.env.localOnly" | "team.env.serversPreferred";
  descKey: "team.env.strategySmartDesc" | "team.env.strategyLocalDesc" | "team.env.strategyServerDesc";
}> = [
  { id: "smart", titleKey: "team.env.smart", descKey: "team.env.strategySmartDesc" },
  { id: "local-only", titleKey: "team.env.localOnly", descKey: "team.env.strategyLocalDesc" },
  { id: "servers-preferred", titleKey: "team.env.serversPreferred", descKey: "team.env.strategyServerDesc" },
];

export function TeamChatHeader({
  group,
  members,
  presence,
  servers,
  workspaces,
  inspectorOpen,
  onToggleInspector,
  onUpdateGroup,
  onOpenServerPicker,
  onMentionBot,
  onOpenAddMember,
}: TeamChatHeaderProps) {
  const { t } = useLocale();
  const [envOpen, setEnvOpen] = useState(false);

  const boundServers = servers.filter((server) => group.execution.serverIds.includes(server.id));
  const hasActiveServers = boundServers.length > 0 && group.execution.strategy !== "local-only";
  const envLabel =
    boundServers.length === 0 || group.execution.strategy === "local-only"
      ? t("team.env.local")
      : group.execution.strategy === "servers-preferred"
        ? t("team.env.serversPreferredCount", { count: boundServers.length })
        : t("team.env.smartWithServers", { count: boundServers.length });

  const setMode = (mode: TeamChatMode) => onUpdateGroup({ mode });
  const setStrategy = (strategy: TeamExecutionStrategy) =>
    onUpdateGroup({
      execution: {
        ...group.execution,
        strategy,
        allowLocal: strategy === "local-only" ? true : group.execution.allowLocal,
      },
    });

  return (
    <div className="shrink-0">
      <header className="team-chat-header">
        <div className="flex min-w-0 items-center gap-3">
          <div className="team-avatar-stack">
            {members.slice(0, 3).map((member) => (
              <SubagentLogo key={member.id} logo={member.logo} name={member.name} size={28} />
            ))}
          </div>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[14.5px] font-semibold tracking-tight text-foreground">
                {group.name}
              </h1>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {t("team.membersCount", { count: members.length })}
              </span>
            </div>
            {group.description && (
              <p className="truncate text-[11.5px] text-muted-foreground">{group.description}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
          {/* 执行环境智能配置 Popover（本机默认可用 + 复用多服务器绑定） */}
          <Popover.Root open={envOpen} onOpenChange={setEnvOpen}>
            <Popover.Trigger asChild>
              <button
                type="button"
                className={cn("team-env-trigger", hasActiveServers && "has-servers")}
                title={t("team.env.title")}
              >
                {hasActiveServers ? (
                  <CodexServerIcon className="size-3.5" />
                ) : (
                  <Laptop size={13} />
                )}
                <span>{envLabel}</span>
              </button>
            </Popover.Trigger>
            <Popover.Portal>
              <Popover.Content
                align="end"
                sideOffset={8}
                className="team-popover-panel"
              >
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="text-[13px] font-semibold text-foreground">{t("team.env.title")}</h2>
                    <p className="mt-0.5 text-[11px] text-muted-foreground">
                      {t("team.env.strategyTitle")}
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setEnvOpen(false);
                      onOpenServerPicker();
                    }}
                    className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 text-xs font-medium text-foreground hover:bg-accent"
                  >
                    <CodexServerIcon className="size-3.5" />
                    {t("team.env.manageServers")}
                  </button>
                </div>

                <div className="mt-2.5 flex flex-col gap-1">
                  {STRATEGIES.map((item) => {
                    const selected = group.execution.strategy === item.id;
                    const disabled = item.id === "servers-preferred" && boundServers.length === 0;
                    return (
                      <button
                        key={item.id}
                        type="button"
                        disabled={disabled}
                        onClick={() => setStrategy(item.id)}
                        className={cn(
                          "team-strategy-card",
                          selected && "is-selected",
                          disabled && "cursor-not-allowed opacity-45",
                        )}
                      >
                        <span className="mt-0.5 text-foreground">
                          {item.id === "smart" ? (
                            <Sparkles size={14} />
                          ) : item.id === "local-only" ? (
                            <Laptop size={14} />
                          ) : (
                            <CodexServerIcon className="size-3.5" />
                          )}
                        </span>
                        <span className="min-w-0 flex-1">
                          <strong className="block text-xs font-medium text-foreground">
                            {t(item.titleKey)}
                          </strong>
                          <small className="mt-0.5 block text-[11px] leading-snug text-muted-foreground">
                            {t(item.descKey)}
                          </small>
                        </span>
                        {selected && <Check size={14} className="mt-0.5 shrink-0 text-foreground" />}
                      </button>
                    );
                  })}
                </div>

                {boundServers.length > 0 && group.execution.strategy !== "local-only" && (
                  <div className="mt-3 flex items-center justify-between gap-3 rounded-lg border border-border/75 bg-muted/35 px-3 py-2">
                    <div className="min-w-0">
                      <div className="text-xs font-medium text-foreground">
                        {t("team.env.allowLocalFallback")}
                      </div>
                      <p className="text-[11px] text-muted-foreground">
                        {t("team.env.allowLocalFallbackDesc")}
                      </p>
                    </div>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={group.execution.allowLocal}
                      onClick={() =>
                        onUpdateGroup({
                          execution: {
                            ...group.execution,
                            allowLocal: !group.execution.allowLocal,
                          },
                        })
                      }
                      className={cn("settings-switch shrink-0", group.execution.allowLocal && "is-on")}
                    >
                      <span />
                    </button>
                  </div>
                )}

                <div className="mt-3 border-t border-border/70 pt-3">
                  <div className="text-[11px] font-medium text-muted-foreground">
                    {t("team.env.boundServers")}
                  </div>
                  {boundServers.length > 0 ? (
                    <div className="mt-1.5 flex flex-wrap gap-1.5">
                      {boundServers.map((server) => (
                        <span
                          key={server.id}
                          className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-2 py-0.5 text-[11px] text-foreground"
                        >
                          <span
                            className={cn(
                              "size-1.5 rounded-full",
                              server.status === "ready" ? "bg-emerald-500" : "bg-muted-foreground/50",
                            )}
                          />
                          <span className="max-w-32 truncate">{server.name}</span>
                        </span>
                      ))}
                    </div>
                  ) : (
                    <p className="mt-1 text-[11.5px] text-muted-foreground">
                      {t("team.env.noServersBound")}
                    </p>
                  )}
                </div>

                {workspaces.length > 0 && (
                  <div className="mt-3 border-t border-border/70 pt-3">
                    <div className="mb-1.5 text-[11px] font-medium text-muted-foreground">
                      {t("team.env.workspace")}
                    </div>
                    <QoneSelect
                      value={group.execution.workspaceId ?? ""}
                      onChange={(workspaceId) =>
                        onUpdateGroup({
                          execution: {
                            ...group.execution,
                            workspaceId: workspaceId || undefined,
                          },
                        })
                      }
                      options={[
                        { value: "", label: t("team.env.noWorkspace") },
                        ...workspaces.map((ws) => ({
                          value: ws.id,
                          label: ws.name,
                          description: ws.path,
                        })),
                      ]}
                      ariaLabel={t("team.env.workspace")}
                      triggerClassName="qone-select-trigger-compact w-full"
                    />
                  </div>
                )}
              </Popover.Content>
            </Popover.Portal>
          </Popover.Root>

          {/* 执行 / 只规划切换胶囊 */}
          <div
            className="inline-flex h-[30px] items-center rounded-full border border-border/80 bg-muted/50 p-0.5"
            role="group"
            aria-label={t("team.mode.execute")}
          >
            <button
              type="button"
              onClick={() => setMode("execute")}
              title={t("team.mode.executeHint")}
              className={cn(
                "h-6 rounded-full px-2.5 text-[11.5px] font-medium transition-colors",
                group.mode === "execute"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("team.mode.execute")}
            </button>
            <button
              type="button"
              onClick={() => setMode("plan")}
              title={t("team.mode.planHint")}
              className={cn(
                "h-6 rounded-full px-2.5 text-[11.5px] font-medium transition-colors",
                group.mode === "plan"
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t("team.mode.plan")}
            </button>
          </div>

          <TooltipIconButton
            tooltip={t("team.inspector.title")}
            aria-pressed={inspectorOpen}
            onClick={onToggleInspector}
            className="size-8"
          >
            <PanelRight size={15} />
          </TooltipIconButton>
        </div>
      </header>

      {/* 群成员在线快捷 @ 栏：点击头像即可 @Ta */}
      <div className="team-roster-strip scrollbar-none">
        {members.map((bot) => {
          const botState = presence[bot.id] ?? "idle";
          const isCoordinator = bot.id === group.coordinatorBotId;
          return (
            <button
              key={bot.id}
              type="button"
              onClick={() => onMentionBot(bot)}
              title={`${bot.name} · ${bot.roleTitle} (${t(`team.presence.${botState}` as Parameters<typeof t>[0])})`}
              className="team-roster-pill"
            >
              <SubagentLogo logo={bot.logo} name={bot.name} size={20} />
              <span className="font-medium">{bot.name}</span>
              {isCoordinator && <Crown size={11} className="text-amber-500" aria-label={t("team.coordinator")} />}
              <span className={cn("team-presence-dot", `is-${botState}`)} aria-hidden="true" />
            </button>
          );
        })}

        <button
          type="button"
          onClick={onOpenAddMember}
          title={t("team.addMember")}
          aria-label={t("team.addMember")}
          className="inline-flex h-7 shrink-0 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:border-foreground/35 hover:text-foreground"
        >
          <Plus size={12} />
          <span>{t("team.addMember")}</span>
        </button>
      </div>
    </div>
  );
}
