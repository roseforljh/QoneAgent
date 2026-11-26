import { useEffect, useMemo, useRef, useState, type ChangeEvent } from "react";
import {
  Camera,
  Crown,
  Laptop,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Trash2,
  UserMinus,
  Users,
} from "lucide-react";
import type { ServerInfo, WorkspaceInfo } from "@qone/protocol";
import { isCustomAvatar } from "../../lib/team/avatar";
import type { TeamBot, TeamBotPresence, TeamExecutionStrategy, TeamGroup } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { CodexFolderIcon, CodexServerIcon } from "../ui/CodexIcon";
import { QoneSelect } from "../ui/Select";
import { NestedDialog } from "../settings/nested-dialog";
import { TeamAvatar, TeamGroupAvatar } from "./TeamAvatar";
import { TeamAvatarCropDialog } from "./TeamAvatarCropDialog";
import { BotModelChip } from "./BotModelChip";
import { FadeScroll } from "../assistant-ui/elements/fade-scroll";
import { TeamMemberCard, type TeamMemberActions } from "./TeamMemberCard";

const MAX_VISIBLE_MEMBERS = 3;
const MAX_VISIBLE_SERVERS = 3;

interface TeamInspectorProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  serversById: ReadonlyMap<string, ServerInfo>;
  activeWorkspace?: WorkspaceInfo;
  presence: Record<string, TeamBotPresence>;
  memberActions: TeamMemberActions;
  onUpdateGroup: (patch: Partial<Omit<TeamGroup, "id" | "createdAt">>) => void;
  onOpenAddMember: () => void;
  onRemoveMember: (botId: string) => void;
  onOpenServerPicker: () => void;
  onClearMessages: () => void;
}

export function TeamInspector({
  group,
  members,
  serversById,
  activeWorkspace,
  presence,
  memberActions,
  onUpdateGroup,
  onOpenAddMember,
  onRemoveMember,
  onOpenServerPicker,
  onClearMessages,
}: TeamInspectorProps) {
  const { t } = useLocale();
  const avatarInputRef = useRef<HTMLInputElement | null>(null);
  const [allMembersOpen, setAllMembersOpen] = useState(false);
  const [memberQuery, setMemberQuery] = useState("");
  const [allServersOpen, setAllServersOpen] = useState(false);
  const [serverQuery, setServerQuery] = useState("");
  const [cropImageUrl, setCropImageUrl] = useState<string | null>(null);
  const [roundsDraft, setRoundsDraft] = useState(() => String(group.maxAutoRounds));

  useEffect(() => {
    setRoundsDraft(String(group.maxAutoRounds));
  }, [group.maxAutoRounds]);

  useEffect(() => () => {
    if (cropImageUrl) URL.revokeObjectURL(cropImageUrl);
  }, [cropImageUrl]);

  const openGroupAvatarPicker = () => {
    avatarInputRef.current?.click();
  };

  const handleGroupAvatarSelected = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    const nextUrl = URL.createObjectURL(file);
    setCropImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return nextUrl;
    });
  };

  const closeCropDialog = (nextOpen: boolean) => {
    if (nextOpen) return;
    setCropImageUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
  };

  const commitRounds = () => {
    const parsed = Number.parseInt(roundsDraft, 10);
    if (!Number.isFinite(parsed)) {
      setRoundsDraft(String(group.maxAutoRounds));
      return;
    }
    const clamped = Math.min(50, Math.max(1, parsed));
    setRoundsDraft(String(clamped));
    if (clamped !== group.maxAutoRounds) {
      onUpdateGroup({ maxAutoRounds: clamped });
    }
  };

  const hasCustomGroupAvatar = isCustomAvatar(group.avatar);
  const boundServers = group.execution.serverIds
    .map((id) => serversById.get(id))
    .filter((server): server is ServerInfo => Boolean(server));
  const visibleServers = boundServers.slice(0, MAX_VISIBLE_SERVERS);
  const hasMoreServers = boundServers.length > MAX_VISIBLE_SERVERS;
  const filteredDialogServers = useMemo(() => {
    const normalized = serverQuery.trim().toLocaleLowerCase();
    if (!normalized) return boundServers;
    return boundServers.filter((server) =>
      `${server.name} ${server.username} ${server.host}`.toLocaleLowerCase().includes(normalized),
    );
  }, [boundServers, serverQuery]);
  const visibleMembers = members.slice(0, MAX_VISIBLE_MEMBERS);
  const hasMoreMembers = members.length > MAX_VISIBLE_MEMBERS;
  const filteredDialogMembers = useMemo(() => {
    const normalized = memberQuery.trim().toLocaleLowerCase();
    if (!normalized) return members;
    return members.filter((bot) =>
      `${bot.name} ${bot.roleTitle} ${bot.description}`.toLocaleLowerCase().includes(normalized),
    );
  }, [members, memberQuery]);

  const renderServerRow = (server: ServerInfo, inDialog = false) => (
    <div
      key={server.id}
      data-slot="team-inspector-server"
      className={
        inDialog
          ? "flex items-center gap-2.5 rounded-xl border border-border/65 bg-background px-2.5 py-2 text-xs"
          : "flex items-center gap-2 border-t border-border/50 pt-1.5"
      }
    >
      <CodexServerIcon className="size-3.5 shrink-0 text-sky-600 dark:text-sky-300" />
      <div className="min-w-0 flex-1">
        <div className="truncate font-medium text-foreground">{server.name}</div>
        <div className="truncate text-[10.5px] text-muted-foreground">
          {server.username}@{server.host}
        </div>
      </div>
      <span
        className={cn(
          "size-2 shrink-0 rounded-full",
          server.status === "ready" ? "bg-emerald-500" : "bg-muted-foreground/40",
        )}
      />
    </div>
  );

  const renderMemberRow = (bot: TeamBot, closeAllOnEdit = false) => {
    const isCoordinator = !group.directBotId && bot.id === group.coordinatorBotId;
    const botState = presence[bot.id] ?? "idle";
    const rowActions: TeamMemberActions = closeAllOnEdit
      ? {
          ...memberActions,
          onEditBot: (target) => {
            setAllMembersOpen(false);
            memberActions.onEditBot(target);
          },
          onDirectChat: memberActions.onDirectChat
            ? (target) => {
                setAllMembersOpen(false);
                memberActions.onDirectChat?.(target);
              }
            : undefined,
          onMentionBot: memberActions.onMentionBot
            ? (target) => {
                setAllMembersOpen(false);
                memberActions.onMentionBot?.(target);
              }
            : undefined,
        }
      : memberActions;

    return (
      <div
        key={bot.id}
        data-slot="team-inspector-member"
        className="group/member flex items-center gap-2.5 rounded-xl border border-border/60 bg-[var(--q-surface)] px-2.5 py-2 transition-colors hover:border-border"
      >
        <TeamMemberCard bot={bot} presence={botState} coordinator={isCoordinator} actions={rowActions}>
          <button type="button" aria-label={bot.name} className="shrink-0 rounded-full">
            <TeamAvatar bot={{ ...bot, name: "" }} size={32} />
          </button>
        </TeamMemberCard>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <strong className="truncate text-xs font-medium text-foreground">{bot.name}</strong>
            {isCoordinator && <Crown size={11} className="shrink-0 text-amber-500" />}
            <span className={cn("team-presence-dot", `is-${botState}`)} aria-hidden="true" />
          </div>
          <div className="flex min-w-0 items-center gap-1.5">
            <span className="truncate text-[10.5px] text-muted-foreground">{bot.roleTitle}</span>
            <BotModelChip bot={bot} onClick={() => rowActions.onEditBot(bot)} />
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-0.5">
          <button
            type="button"
            onClick={() => rowActions.onEditBot(bot)}
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
  };

  return (
    <aside className="team-inspector">
      <div className="team-inspector-head">
        <div className="flex min-w-0 items-center gap-2">
          <Users size={14} className="shrink-0 text-muted-foreground" />
          <h2 className="truncate text-[13px] font-semibold text-foreground">
            {t("team.inspector.overview")}
          </h2>
        </div>
      </div>

      <FadeScroll className="flex-1 p-3.5">
        <div className="flex flex-col gap-4">
          {/* 基本群信息 */}
          {!group.directBotId && (
            <section className="flex flex-col gap-2.5">
              <input
                ref={avatarInputRef}
                type="file"
                accept="image/*"
                className="sr-only"
                tabIndex={-1}
                onChange={handleGroupAvatarSelected}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={openGroupAvatarPicker}
                  title={t("team.inspector.groupAvatarHint")}
                  aria-label={t("team.inspector.groupAvatarHint")}
                  className="team-group-avatar-trigger"
                >
                  <TeamGroupAvatar group={group} members={members} size={48} stackSize={24} />
                  <span className="team-avatar-trigger-overlay" aria-hidden="true">
                    <Camera size={15} />
                  </span>
                </button>
                <div className="flex min-w-0 flex-1 flex-col gap-1">
                  <input
                    value={group.name}
                    onChange={(event) => onUpdateGroup({ name: event.target.value })}
                    placeholder={t("team.dialog.groupNamePlaceholder")}
                    aria-label={t("team.inspector.groupName")}
                    className="h-9 w-full rounded-lg border border-border/70 bg-[var(--q-surface)] px-2.5 text-[13px] font-medium text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-foreground/35"
                  />
                  {hasCustomGroupAvatar && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!(await confirmDestructiveAction(t("team.inspector.groupAvatarResetConfirm")))) return;
                        onUpdateGroup({ avatar: "" });
                      }}
                      className="inline-flex w-fit items-center gap-1 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
                    >
                      <RotateCcw size={10.5} />
                      <span>{t("team.inspector.groupAvatarReset")}</span>
                    </button>
                  )}
                </div>
              </div>

              <label className="flex flex-col gap-1 text-[11.5px] font-medium text-muted-foreground">
                <span>{t("team.inspector.announcement")}</span>
                <textarea
                  rows={3}
                  value={group.announcement}
                  onChange={(event) => onUpdateGroup({ announcement: event.target.value })}
                  placeholder={t("team.inspector.announcementPlaceholder")}
                  className="resize-none rounded-lg border border-border/70 bg-[var(--q-surface)] p-2.5 text-xs leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/70 focus:border-foreground/35"
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

              <label className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-[var(--q-surface)] px-2.5 py-2 text-xs">
                <span className="text-muted-foreground">{t("team.inspector.maxRounds")}</span>
                <input
                  type="text"
                  inputMode="numeric"
                  value={roundsDraft}
                  onChange={(event) => {
                    const digits = event.target.value.replace(/\D/g, "").slice(0, 2);
                    setRoundsDraft(digits);
                    const parsed = Number.parseInt(digits, 10);
                    if (Number.isFinite(parsed) && parsed >= 1 && parsed <= 50 && parsed !== group.maxAutoRounds) {
                      onUpdateGroup({ maxAutoRounds: parsed });
                    }
                  }}
                  onBlur={commitRounds}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      commitRounds();
                      event.currentTarget.blur();
                    }
                  }}
                  className="w-14 rounded-md border border-border/80 bg-background/70 px-2 py-0.5 text-center font-mono text-xs text-foreground outline-none tabular-nums focus:border-foreground/35"
                />
              </label>
            </section>
          )}

          {/* 群成员管理 */}
          <section className={cn(!group.directBotId && "border-t border-border/50 pt-3.5")}>
            {!group.directBotId && (
              <div className="mb-2 flex items-center justify-between">
                <h3 className="text-xs font-semibold text-foreground">
                  {t("team.membersCount", { count: members.length })}
                </h3>
                <button
                  type="button"
                  onClick={onOpenAddMember}
                  className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-[var(--q-surface)] px-2 text-[11px] font-medium text-foreground transition-colors hover:border-foreground/25 hover:bg-accent"
                >
                  <Plus size={11} />
                  {t("team.addMember")}
                </button>
              </div>
            )}

            <div className="flex flex-col gap-1.5">
              {visibleMembers.map((bot) => renderMemberRow(bot))}
            </div>

            {hasMoreMembers && (
              <button
                type="button"
                onClick={() => {
                  setMemberQuery("");
                  setAllMembersOpen(true);
                }}
                className="mt-2 flex w-full items-center justify-center rounded-lg border border-border/70 bg-[var(--q-surface)] py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-accent hover:text-foreground"
              >
                {t("team.viewAllMembers", { count: members.length })}
              </button>
            )}
          </section>

          {/* 执行环境概览与策略配置 */}
          <section className="border-t border-border/50 pt-3.5">
            <div className="mb-2 flex items-center justify-between">
              <h3 className="text-xs font-semibold text-foreground">{t("team.env.title")}</h3>
              <button
                type="button"
                onClick={onOpenServerPicker}
                className="inline-flex h-6 items-center gap-1 rounded-md border border-border/70 bg-[var(--q-surface)] px-2 text-[11px] font-medium text-foreground transition-colors hover:border-foreground/25 hover:bg-accent"
              >
                <CodexServerIcon className="size-3" />
                {t("team.env.manageServers")}
              </button>
            </div>

            <div className="mb-2 flex flex-col gap-1.5">
              <QoneSelect
                value={group.execution.strategy}
                onChange={(value) => {
                  const strategy = value as TeamExecutionStrategy;
                  onUpdateGroup({
                    execution: {
                      ...group.execution,
                      strategy,
                      allowLocal: strategy === "local-only" ? true : group.execution.allowLocal,
                    },
                  });
                }}
                options={[
                  { value: "smart", label: t("team.env.smart"), description: t("team.env.strategySmartDesc") },
                  { value: "local-only", label: t("team.env.localOnly"), description: t("team.env.strategyLocalDesc") },
                  {
                    value: "servers-preferred",
                    label: t("team.env.serversPreferred"),
                    description: t("team.env.strategyServerDesc"),
                    disabled: boundServers.length === 0,
                  },
                ]}
                ariaLabel={t("team.env.strategyTitle")}
                triggerClassName="qone-select-trigger-compact w-full"
              />

              {boundServers.length > 0 && group.execution.strategy !== "local-only" && (
                <div
                  className="flex items-center justify-between gap-2 rounded-lg border border-border/70 bg-[var(--q-surface)] px-2.5 py-1.5 text-xs"
                  title={t("team.env.allowLocalFallbackDesc")}
                >
                  <span className="truncate text-muted-foreground">{t("team.env.allowLocalFallback")}</span>
                  <button
                    type="button"
                    role="switch"
                    aria-checked={group.execution.allowLocal}
                    aria-label={t("team.env.allowLocalFallback")}
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
            </div>

            <div className="flex flex-col gap-1.5 rounded-xl border border-border/60 bg-[var(--q-surface)] p-2.5 text-xs">
              <div className="flex items-center gap-2">
                <Laptop size={13} className="shrink-0 text-emerald-500" />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-1.5">
                    <span className="shrink-0 font-medium text-foreground">{t("team.env.local")}</span>
                    {activeWorkspace && (
                      <span className="inline-flex min-w-0 items-center gap-1 truncate text-[11px] text-muted-foreground" title={activeWorkspace.path}>
                        <CodexFolderIcon className="size-3 shrink-0" />
                        <span className="truncate">{activeWorkspace.name}</span>
                      </span>
                    )}
                  </div>
                  {activeWorkspace && (
                    <div className="truncate text-[10.5px] text-muted-foreground" title={activeWorkspace.path}>
                      {activeWorkspace.path}
                    </div>
                  )}
                </div>
                <span className="ml-auto shrink-0 rounded-full bg-emerald-500/12 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700 dark:text-emerald-300">
                  {group.execution.allowLocal || boundServers.length === 0
                    ? t("team.presence.idle")
                    : t("team.env.serversPreferred")}
                </span>
              </div>

              {visibleServers.map((server) => renderServerRow(server))}
            </div>

            {hasMoreServers && (
              <button
                type="button"
                onClick={() => {
                  setServerQuery("");
                  setAllServersOpen(true);
                }}
                className="mt-2 flex w-full items-center justify-center rounded-lg border border-border/80 bg-background py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-foreground/25 hover:bg-accent hover:text-foreground"
              >
                {t("team.viewAllServers", { count: boundServers.length })}
              </button>
            )}
          </section>

          {/* 危险操作 */}
          <section className="border-t border-border/50 pt-3">
            <button
              type="button"
              onClick={onClearMessages}
              className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-border/70 bg-[var(--q-surface)] py-2 text-xs text-muted-foreground transition-colors hover:border-destructive/40 hover:text-destructive"
            >
              <Trash2 size={13} />
              {t("team.clearMessages")}
            </button>
          </section>
        </div>
      </FadeScroll>

      <NestedDialog
        open={allMembersOpen}
        onOpenChange={setAllMembersOpen}
        title={t("team.allMembersTitle", { count: members.length })}
      >
        <div className="flex flex-col gap-3">
          <label className="relative flex items-center">
            <Search size={13} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
            <input
              value={memberQuery}
              onChange={(event) => setMemberQuery(event.target.value)}
              placeholder={t("team.dialog.searchMembers")}
              aria-label={t("team.dialog.searchMembers")}
              className="h-8 w-full rounded-lg border border-border/80 bg-background pr-2.5 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/35"
            />
          </label>
          <div className="flex max-h-[360px] flex-col gap-1.5 overflow-y-auto pr-0.5">
            {filteredDialogMembers.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("team.allMembersEmpty")}
              </p>
            ) : (
              filteredDialogMembers.map((bot) => renderMemberRow(bot, true))
            )}
          </div>
        </div>
      </NestedDialog>

      <NestedDialog
        open={allServersOpen}
        onOpenChange={setAllServersOpen}
        title={t("team.allServersTitle", { count: boundServers.length })}
      >
        <div className="flex flex-col gap-3">
          <label className="relative flex items-center">
            <Search size={13} className="pointer-events-none absolute left-2.5 text-muted-foreground" />
            <input
              value={serverQuery}
              onChange={(event) => setServerQuery(event.target.value)}
              placeholder={t("team.dialog.searchServers")}
              aria-label={t("team.dialog.searchServers")}
              className="h-8 w-full rounded-lg border border-border/80 bg-background pr-2.5 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/35"
            />
          </label>
          <div className="flex max-h-[360px] flex-col gap-1.5 overflow-y-auto pr-0.5">
            {filteredDialogServers.length === 0 ? (
              <p className="py-8 text-center text-xs text-muted-foreground">
                {t("team.allServersEmpty")}
              </p>
            ) : (
              filteredDialogServers.map((server) => renderServerRow(server, true))
            )}
          </div>
        </div>
      </NestedDialog>

      <TeamAvatarCropDialog
        open={Boolean(cropImageUrl)}
        imageUrl={cropImageUrl}
        onOpenChange={closeCropDialog}
        onRechoose={openGroupAvatarPicker}
        onConfirm={(dataUrl) => onUpdateGroup({ avatar: dataUrl })}
      />
    </aside>
  );
}
