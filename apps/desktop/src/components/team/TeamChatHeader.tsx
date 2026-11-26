import { useState } from "react";
import { Popover } from "radix-ui";
import {
  Check,
  ChevronDown,
  FolderPlus,
} from "lucide-react";
import type { WorkspaceInfo } from "@qone/protocol";
import type {
  TeamBot,
  TeamChatMode,
  TeamGroup,
} from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { CodexFolderIcon, CodexIcon } from "../ui/CodexIcon";
import sidebarIcon from "../../assets/codex-icons/sidebar-light-16.svg";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";

interface TeamChatHeaderProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  workspaces: readonly WorkspaceInfo[];
  currentWorkspaceId?: string;
  onImportWorkspace: () => void;
  sidebarCollapsed: boolean;
  onExpandSidebar: () => void;
  onUpdateGroup: (patch: Partial<Omit<TeamGroup, "id" | "createdAt">>) => void;
}

export function TeamChatHeader({
  group,
  members,
  workspaces,
  currentWorkspaceId,
  onImportWorkspace,
  sidebarCollapsed,
  onExpandSidebar,
  onUpdateGroup,
}: TeamChatHeaderProps) {
  const { t } = useLocale();
  const [workspaceOpen, setWorkspaceOpen] = useState(false);

  const fallbackWorkspace = workspaces.find((ws) => ws.id === currentWorkspaceId) ?? workspaces[0];
  const activeWorkspace = workspaces.find((ws) => ws.id === group.execution.workspaceId) ?? fallbackWorkspace;

  const setWorkspace = (workspaceId?: string) =>
    onUpdateGroup({
      execution: {
        ...group.execution,
        workspaceId,
      },
    });

  const setMode = (mode: TeamChatMode) => onUpdateGroup({ mode });

  return (
    <div className="shrink-0">
      <header className="team-chat-header">
        <div className="flex min-w-0 items-center gap-3">
          {sidebarCollapsed && (
            <TooltipIconButton
              tooltip={t("sidebar.expand")}
              onClick={onExpandSidebar}
              className="size-8 shrink-0"
            >
              <CodexIcon src={sidebarIcon} className="size-4" />
            </TooltipIconButton>
          )}
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1 className="truncate text-[14.5px] font-semibold tracking-tight text-foreground">
                {group.name}
              </h1>
              <span className="shrink-0 rounded-full bg-muted px-2 py-0.5 text-[11px] text-muted-foreground">
                {group.directBotId ? t("team.member.direct") : t("team.membersCount", { count: members.length })}
              </span>
              {/* 当前所在项目展示与快捷切换入口 */}
              {workspaces.length > 0 ? (
                <Popover.Root open={workspaceOpen} onOpenChange={setWorkspaceOpen}>
                  <Popover.Trigger asChild>
                    <button
                      type="button"
                      data-slot="team-workspace-trigger"
                      title={activeWorkspace ? `${t("team.env.workspace")}: ${activeWorkspace.path}` : t("team.env.workspace")}
                      className="inline-flex h-6 max-w-[180px] shrink-0 items-center gap-1.5 rounded-full border border-border/80 bg-muted/45 px-2.5 text-[11.5px] font-medium text-foreground transition-colors hover:border-foreground/30 hover:bg-muted/80"
                    >
                      <CodexFolderIcon className="size-3 shrink-0 text-muted-foreground" />
                      <span className="truncate">{activeWorkspace?.name ?? t("team.env.noProjectSelected")}</span>
                      <ChevronDown size={11} className="shrink-0 text-muted-foreground" />
                    </button>
                  </Popover.Trigger>
                  <Popover.Portal>
                    <Popover.Content align="start" sideOffset={8} className="team-popover-panel w-[290px] p-2">
                      <div className="px-2 pt-1 pb-1.5 text-[11px] font-medium text-muted-foreground">
                        {t("team.env.workspace")}
                      </div>
                      <div className="flex max-h-60 flex-col gap-0.5 overflow-y-auto">
                        {workspaces.map((ws) => {
                          const selected = activeWorkspace?.id === ws.id;
                          return (
                            <button
                              key={ws.id}
                              type="button"
                              onClick={() => {
                                setWorkspace(ws.id);
                                setWorkspaceOpen(false);
                              }}
                              className={cn(
                                "flex w-full items-center gap-2 rounded-lg px-2 py-1.5 text-left transition-colors hover:bg-accent",
                                selected && "bg-accent/70",
                              )}
                            >
                              <CodexFolderIcon className="size-3.5 shrink-0 text-muted-foreground" />
                              <span className="min-w-0 flex-1">
                                <strong className="block truncate text-xs font-medium text-foreground">{ws.name}</strong>
                                <small className="block truncate text-[10.5px] text-muted-foreground">{ws.path}</small>
                              </span>
                              {selected && <Check size={13} className="shrink-0 text-foreground" />}
                            </button>
                          );
                        })}
                      </div>
                      <div className="mt-1.5 border-t border-border/70 pt-1.5">
                        <button
                          type="button"
                          onClick={() => {
                            setWorkspaceOpen(false);
                            onImportWorkspace();
                          }}
                          className="flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                        >
                          <FolderPlus size={13} />
                          <span>{t("team.env.importProject")}</span>
                        </button>
                      </div>
                    </Popover.Content>
                  </Popover.Portal>
                </Popover.Root>
              ) : (
                <button
                  type="button"
                  data-slot="team-workspace-trigger"
                  onClick={onImportWorkspace}
                  title={t("team.env.importProject")}
                  className="inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full border border-dashed border-border px-2.5 text-[11.5px] text-muted-foreground transition-colors hover:border-foreground/35 hover:text-foreground"
                >
                  <FolderPlus size={11} />
                  <span>{t("team.env.noProjectSelected")}</span>
                </button>
              )}
            </div>
            {group.description && (
              <p className="truncate text-[11.5px] text-muted-foreground">{group.description}</p>
            )}
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-2">
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
        </div>
      </header>
    </div>
  );
}
