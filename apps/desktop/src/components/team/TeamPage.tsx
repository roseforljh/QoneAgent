import { useEffect, useMemo, useRef, useState } from "react";
import { Plus, Sparkles } from "lucide-react";
import { useStore } from "../../store";
import { sendServerCommand, useServerStore } from "../../lib/server-state";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { usePaneSizes } from "../../lib/pane-size-preferences";
import { DEFAULT_TEAM_GROUP_TEMPLATES } from "../../lib/team/presets";
import { useTeamStore, type CreateBotInput, type CreateGroupInput } from "../../lib/team/store";
import type { TeamBot, TeamGroup, TeamMentionRef, TeamMessage } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { Button } from "../ui/Button";
import { CodexIcon } from "../ui/CodexIcon";
import sidebarIcon from "../../assets/codex-icons/sidebar-light-16.svg";
import { TooltipIconButton } from "../assistant-ui/tooltip-icon-button";
import { ResizableSidebar } from "../assistant-ui/resizable-sidebar";
import { TeamAvatar } from "./TeamAvatar";
import { ServerPickerDialog } from "../assistant-ui/server-picker-dialog";
import { TeamSidebar } from "./TeamSidebar";
import { TeamChatHeader } from "./TeamChatHeader";
import { TeamMessageList } from "./TeamMessageList";
import { TeamComposer, type TeamComposerDraft, type TeamComposerHandle } from "./TeamComposer";
import { TeamInspector } from "./TeamInspector";
import { TeamResizableInspector } from "./TeamResizableInspector";
import type { TeamMemberActions } from "./TeamMemberCard";
import { CreateTeamGroupDialog } from "./CreateTeamGroupDialog";
import { BotEditorDialog } from "./BotEditorDialog";
import { TeamAddMemberDialog } from "./TeamAddMemberDialog";
import "./team.css";

const EMPTY_MESSAGES: TeamMessage[] = [];
const EMPTY_RUNS = [] as const;
const EMPTY_PRESENCE = {};

export function TeamPage() {
  const { t } = useLocale();
  const composerRef = useRef<TeamComposerHandle>(null);
  const drafts = useRef(new Map<string, TeamComposerDraft>());

  // 读取项目已有的全局真实配置（服务器、模型、项目目录）
  const connected = useStore((state) => state.connected);
  const send = useStore((state) => state.send);
  const workspaces = useStore((state) => state.workspaces);
  const selectedModelId = useStore((state) => state.selectedModelId);
  const permissionMode = useStore((state) =>
    state.currentSessionId
      ? state.runOptionsBySession[state.currentSessionId]?.permissionMode ?? state.draftRunOptions.permissionMode
      : state.draftRunOptions.permissionMode,
  );
  const currentWorkspaceId = useStore((state) => state.currentWorkspaceId);
  const chooseWorkspace = useStore((state) => state.chooseWorkspace);
  const servers = useServerStore((state) => state.servers);
  const serversLoaded = useServerStore((state) => state.loaded);

  // 团队状态库（后端运行时为唯一数据源）
  const loaded = useTeamStore((state) => state.loaded);
  const bots = useTeamStore((state) => state.bots);
  const groups = useTeamStore((state) => state.groups);
  const activeGroupId = useTeamStore((state) => state.activeGroupId);
  const messagesByGroup = useTeamStore((state) => state.messagesByGroup);
  const runsByGroup = useTeamStore((state) => state.runsByGroup);
  const presenceByGroup = useTeamStore((state) => state.presenceByGroup);
  const ensurePresets = useTeamStore((state) => state.ensurePresets);
  const selectGroup = useTeamStore((state) => state.selectGroup);
  const createGroup = useTeamStore((state) => state.createGroup);
  const openDirectChat = useTeamStore((state) => state.openDirectChat);
  const updateGroup = useTeamStore((state) => state.updateGroup);
  const deleteGroup = useTeamStore((state) => state.deleteGroup);
  const clearGroupMessages = useTeamStore((state) => state.clearGroupMessages);
  const createBot = useTeamStore((state) => state.createBot);
  const updateBot = useTeamStore((state) => state.updateBot);
  const deleteBot = useTeamStore((state) => state.deleteBot);
  const addMemberToGroup = useTeamStore((state) => state.addMemberToGroup);
  const removeMemberFromGroup = useTeamStore((state) => state.removeMemberFromGroup);
  const sendMessage = useTeamStore((state) => state.sendMessage);
  const updateRunAction = useTeamStore((state) => state.updateRunAction);

  // 界面交互状态
  const sidebarWidth = usePaneSizes((state) => state.sidebarWidth);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [createGroupTemplateId, setCreateGroupTemplateId] = useState<string | undefined>(undefined);
  const [botDialogOpen, setBotDialogOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<TeamBot | undefined>(undefined);
  const [botCreateTarget, setBotCreateTarget] = useState<"library" | "create-group" | "active-group">("library");
  const [newlyCreatedBotId, setNewlyCreatedBotId] = useState<string | undefined>(undefined);
  const [addMemberOpen, setAddMemberOpen] = useState(false);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [replyMessage, setReplyTo] = useState<TeamMessage | undefined>(undefined);

  // 响应应用顶栏与 Ctrl+B 的侧边栏切换事件
  useEffect(() => {
    const toggleSidebar = () => setSidebarCollapsed((collapsed) => !collapsed);
    window.addEventListener("qone-toggle-sidebar", toggleSidebar);
    return () => window.removeEventListener("qone-toggle-sidebar", toggleSidebar);
  }, []);

  // 后端状态到达后补齐当前语言的预设成员。
  useEffect(() => {
    if (loaded) ensurePresets((key) => t(key as Parameters<typeof t>[0]));
  }, [loaded, ensurePresets, t]);

  useEffect(() => {
    if (connected && !serversLoaded) {
      void sendServerCommand({ type: "servers.list" }, send);
    }
  }, [connected, serversLoaded, send]);

  const botsById = useMemo(() => new Map(bots.map((bot) => [bot.id, bot])), [bots]);
  const serversById = useMemo(() => new Map(servers.map((server) => [server.id, server])), [servers]);
  const botByPresetKey = useMemo(() => {
    const map = new Map<string, TeamBot>();
    for (const bot of bots) {
      if (bot.presetKey) map.set(bot.presetKey, bot);
    }
    return map;
  }, [bots]);

  const activeGroup = useMemo(() => {
    const group = groups.find((item) => item.id === activeGroupId) ?? groups[0];
    const peer = group?.directBotId ? botsById.get(group.directBotId) : undefined;
    return group && peer ? { ...group, name: peer.name } : group;
  }, [groups, activeGroupId, botsById]);

  const activeMembers = useMemo(() => {
    if (!activeGroup) return [];
    return activeGroup.memberBotIds
      .map((id) => botsById.get(id))
      .filter((bot): bot is TeamBot => Boolean(bot));
  }, [activeGroup, botsById]);

  const activeMessages = activeGroup ? (messagesByGroup[activeGroup.id] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
  const activeRuns = activeGroup ? (runsByGroup[activeGroup.id] ?? EMPTY_RUNS) : EMPTY_RUNS;
  const activePresence = activeGroup ? (presenceByGroup[activeGroup.id] ?? EMPTY_PRESENCE) : EMPTY_PRESENCE;
  const replyTo = replyMessage?.groupId === activeGroup?.id ? replyMessage : undefined;

  // 切换会话时清除未发出的回复引用。
  const handleSelectGroup = (groupId: string) => {
    setReplyTo(undefined);
    selectGroup(groupId);
  };

  const handleOpenDirectChat = (bot: TeamBot) => {
    setReplyTo(undefined);
    openDirectChat(bot);
    requestAnimationFrame(() => composerRef.current?.focus());
  };

  const replySenderName = useMemo(() => {
    if (!replyTo) return undefined;
    if (replyTo.senderKind === "user") return t("team.you");
    return botsById.get(replyTo.senderBotId ?? "")?.name;
  }, [replyTo, botsById, t]);

  const openCreateGroup = (templateId?: string) => {
    setCreateGroupTemplateId(templateId);
    setNewlyCreatedBotId(undefined);
    setCreateGroupOpen(true);
  };

  const openBotEditor = (target: "library" | "create-group" | "active-group", bot?: TeamBot) => {
    setEditingBot(bot);
    setBotCreateTarget(target);
    setBotDialogOpen(true);
  };

  const handleSaveBot = (input: CreateBotInput, editingBotId?: string) => {
    if (editingBotId) {
      updateBot(editingBotId, input);
      return;
    }
    const created = createBot(input);
    if (botCreateTarget === "create-group") {
      setNewlyCreatedBotId(created.id);
    } else if (botCreateTarget === "active-group" && activeGroup) {
      addMemberToGroup(activeGroup.id, created.id);
    }
  };

  const memberActions: TeamMemberActions = {
    onDirectChat: activeGroup?.directBotId ? undefined : handleOpenDirectChat,
    onMentionBot: activeGroup?.directBotId ? undefined : (bot) => composerRef.current?.insertMention(bot),
    onEditBot: (bot) => openBotEditor("library", bot),
  };

  const handleCreateGroup = (input: CreateGroupInput) => {
    createGroup(input);
  };

  const handleDeleteGroup = async (group: TeamGroup) => {
    if (!(await confirmDestructiveAction(t("team.deleteGroupConfirm", { name: group.name })))) return;
    deleteGroup(group.id);
  };

  const handleDeleteBot = async (bot: TeamBot) => {
    if (!(await confirmDestructiveAction(t("team.deleteBotConfirm", { name: bot.name })))) return;
    deleteBot(bot.id);
  };

  const handleClearMessages = async () => {
    if (!activeGroup) return;
    if (!(await confirmDestructiveAction(t("team.clearMessagesConfirm", { name: activeGroup.name })))) return;
    clearGroupMessages(activeGroup.id);
  };

  const handleRemoveMember = async (botId: string) => {
    if (!activeGroup) return;
    const memberName = botsById.get(botId)?.name ?? "";
    if (!(await confirmDestructiveAction(t("team.removeMemberConfirm", { name: memberName, group: activeGroup.name })))) return;
    removeMemberFromGroup(activeGroup.id, botId);
  };

  const handleSendMessage = (content: string, mentions: TeamMentionRef[], attachments?: import("@qone/protocol").MessageAttachmentInfo[]) => {
    if (!activeGroup) return;
    const sent = sendMessage({
      groupId: activeGroup.id,
      content,
      mentions,
      attachments,
      replyToMessageId: replyTo?.id,
      defaults: {
        ...(selectedModelId ? { model: selectedModelId } : {}),
        ...(permissionMode ? { permissionMode } : {}),
        ...(currentWorkspaceId ? { workspaceId: currentWorkspaceId } : {}),
      },
    });
    if (!sent) return;
    setReplyTo(undefined);
  };

  return (
    <div className="team-shell">
      <ResizableSidebar collapsed={sidebarCollapsed} onCollapsedChange={setSidebarCollapsed}>
        <TeamSidebar
          groups={groups}
          bots={bots}
          activeGroupId={activeGroup?.id}
          messagesByGroup={messagesByGroup}
          serversById={serversById}
          onSelectGroup={handleSelectGroup}
          onOpenCreateGroup={() => openCreateGroup()}
          onDeleteGroup={(group) => void handleDeleteGroup(group)}
          onCollapse={() => setSidebarCollapsed(true)}
        />
      </ResizableSidebar>

      <main className="team-stage">
        {activeGroup ? (
          <>
            <TeamChatHeader
              group={activeGroup}
              members={activeMembers}
              workspaces={workspaces}
              currentWorkspaceId={currentWorkspaceId}
              onImportWorkspace={() => void chooseWorkspace()}
              sidebarCollapsed={sidebarCollapsed}
              onExpandSidebar={() => setSidebarCollapsed(false)}
              onUpdateGroup={(patch) => updateGroup(activeGroup.id, patch)}
            />

            <div className="relative flex min-h-0 flex-1 flex-col">

              <TeamMessageList
                key={`messages:${activeGroup.id}`}
                group={activeGroup}
                members={activeMembers}
                botsById={botsById}
                serversById={serversById}
                messages={activeMessages}
                runs={activeRuns}
                presence={activePresence}
                memberActions={memberActions}
                onReply={(message) => {
                  setReplyTo(message);
                  composerRef.current?.focus();
                }}
                onQuickPrompt={(prompt) => composerRef.current?.setDraft(prompt)}
                onRunAction={updateRunAction}
              />

              {activeGroup.directBotId && activeMembers.length === 0 ? (
                <p className="p-4 text-center text-xs text-muted-foreground">{t("team.member.unavailable")}</p>
              ) : (
                <TeamComposer
                  key={`composer:${activeGroup.id}`}
                  ref={composerRef}
                  group={activeGroup}
                  members={activeMembers}
                  servers={servers}
                  drafts={drafts.current}
                  replyTo={replyTo}
                  replySenderName={replySenderName}
                  onCancelReply={() => setReplyTo(undefined)}
                  onSend={handleSendMessage}
                  onOpenServerPicker={() => setServerPickerOpen(true)}
                  onOpenCreateAndAddBot={() => openBotEditor("active-group")}
                />
              )}
            </div>
          </>
        ) : (
          /* 首次进入团队模式的零门槛引导画布 */
          <div className="relative flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
            {sidebarCollapsed && (
              <TooltipIconButton
                tooltip={t("sidebar.expand")}
                onClick={() => setSidebarCollapsed(false)}
                className="absolute top-3 left-3.5 size-8"
              >
                <CodexIcon src={sidebarIcon} className="size-4" />
              </TooltipIconButton>
            )}
            <div className="w-full max-w-[680px] text-center">
              <h1 className="text-2xl font-semibold tracking-tight text-foreground">
                {t("team.emptyGroupsTitle")}
              </h1>

              <div className="mt-6 flex items-center justify-center gap-2.5">
                <Button onClick={() => openCreateGroup()}>
                  <Plus size={15} />
                  {t("team.emptyGroupsCta")}
                </Button>
                <Button variant="outline" onClick={() => openBotEditor("library")}>
                  <Sparkles size={14} />
                  {t("team.newBot")}
                </Button>
              </div>

              <div className="team-template-grid mt-8 text-left">
                {DEFAULT_TEAM_GROUP_TEMPLATES.map((template) => {
                  const templateBots = template.botPresetKeys
                    .map((key) => botByPresetKey.get(key))
                    .filter((bot): bot is TeamBot => Boolean(bot));
                  return (
                    <button
                      key={template.id}
                      type="button"
                      onClick={() => openCreateGroup(template.id)}
                      className="team-template-card"
                    >
                      <div className="flex items-center justify-between">
                        <div className="team-avatar-stack">
                          {templateBots.map((bot) => (
                            <TeamAvatar key={bot.id} bot={bot} size={26} />
                          ))}
                        </div>
                        <span className="text-[11px] font-medium text-muted-foreground">
                          {t("team.membersCount", { count: templateBots.length })}
                        </span>
                      </div>
                      <div>
                        <strong className="block text-sm font-semibold text-foreground">
                          {t(template.nameKey as Parameters<typeof t>[0])}
                        </strong>
                        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                          {t(template.descriptionKey as Parameters<typeof t>[0])}
                        </p>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          </div>
        )}
      </main>

      {activeGroup && (
        <TeamResizableInspector
          reservedLeftWidth={sidebarCollapsed ? 0 : sidebarWidth}
        >
          <TeamInspector
            key={activeGroup.id}
            group={activeGroup}
            members={activeMembers}
            serversById={serversById}
            activeWorkspace={
              workspaces.find((ws) => ws.id === activeGroup.execution.workspaceId)
              ?? workspaces.find((ws) => ws.id === currentWorkspaceId)
              ?? workspaces[0]
            }
            presence={activePresence}
            memberActions={memberActions}
            onUpdateGroup={(patch) => updateGroup(activeGroup.id, patch)}
            onOpenAddMember={() => setAddMemberOpen(true)}
            onRemoveMember={(botId) => void handleRemoveMember(botId)}
            onOpenServerPicker={() => setServerPickerOpen(true)}
            onClearMessages={() => void handleClearMessages()}
          />
        </TeamResizableInspector>
      )}

      {activeGroup && !activeGroup.directBotId && (
        <TeamAddMemberDialog
          open={addMemberOpen}
          onOpenChange={setAddMemberOpen}
          group={activeGroup}
          allBots={bots}
          onAddMembers={(botIds) => {
            for (const botId of botIds) addMemberToGroup(activeGroup.id, botId);
          }}
          onOpenCreateBot={() => openBotEditor("active-group")}
          onEditBot={(bot) => openBotEditor("library", bot)}
          onDeleteBot={(bot) => void handleDeleteBot(bot)}
        />
      )}

      <CreateTeamGroupDialog
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        bots={bots}
        servers={servers}
        workspaces={workspaces}
        initialTemplateId={createGroupTemplateId}
        newlyCreatedBotId={newlyCreatedBotId}
        onRequestCreateBot={() => openBotEditor("create-group")}
        onEditBot={(bot) => openBotEditor("create-group", bot)}
        onSubmit={handleCreateGroup}
      />

      <BotEditorDialog
        open={botDialogOpen}
        onOpenChange={setBotDialogOpen}
        editingBot={editingBot}
        nested={botCreateTarget === "create-group"}
        onSave={handleSaveBot}
      />

      {activeGroup && (
        <ServerPickerDialog
          open={serverPickerOpen}
          onOpenChange={setServerPickerOpen}
          title={t("servers.title")}
          description={t("team.env.serverPickerDesc")}
          ids={activeGroup.execution.serverIds}
          onChange={(serverIds) =>
            updateGroup(activeGroup.id, {
              execution: { ...activeGroup.execution, serverIds },
            })
          }
        />
      )}
    </div>
  );
}
