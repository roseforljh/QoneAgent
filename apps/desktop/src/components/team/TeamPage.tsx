import { useEffect, useMemo, useRef, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import { Laptop, Plus, Sparkles } from "lucide-react";
import { useStore } from "../../store";
import { sendServerCommand, useServerStore } from "../../lib/server-state";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { DEFAULT_TEAM_GROUP_TEMPLATES } from "../../lib/team/presets";
import { useTeamStore, type CreateBotInput, type CreateGroupInput } from "../../lib/team/store";
import type { TeamBot, TeamGroup, TeamMentionRef, TeamMessage } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { Button } from "../ui/Button";
import { SubagentLogo } from "../settings/subagent-logo";
import { ServerPickerDialog } from "../assistant-ui/server-picker-dialog";
import { TeamSidebar } from "./TeamSidebar";
import { TeamChatHeader } from "./TeamChatHeader";
import { TeamMessageList } from "./TeamMessageList";
import { TeamComposer, type TeamComposerHandle } from "./TeamComposer";
import { TeamInspector } from "./TeamInspector";
import { CreateTeamGroupDialog } from "./CreateTeamGroupDialog";
import { BotEditorDialog } from "./BotEditorDialog";
import "./team.css";

const EMPTY_MESSAGES: TeamMessage[] = [];
const EMPTY_RUNS = [] as const;
const EMPTY_PRESENCE = {};

export function TeamPage() {
  const { t } = useLocale();
  const composerRef = useRef<TeamComposerHandle>(null);

  // 读取项目已有的全局真实配置（服务器、模型、项目目录、子代理）
  const connected = useStore((state) => state.connected);
  const send = useStore((state) => state.send);
  const workspaces = useStore((state) => state.workspaces);
  const modelConfigs = useStore((state) => state.modelConfigs);
  const subagentProfiles = useStore((state) => state.subagentConfig.profiles);
  const servers = useServerStore((state) => state.servers);
  const serversLoaded = useServerStore((state) => state.loaded);

  // 团队状态库
  const bots = useTeamStore((state) => state.bots);
  const groups = useTeamStore((state) => state.groups);
  const activeGroupId = useTeamStore((state) => state.activeGroupId);
  const messagesByGroup = useTeamStore((state) => state.messagesByGroup);
  const runsByGroup = useTeamStore((state) => state.runsByGroup);
  const presenceByGroup = useTeamStore((state) => state.presenceByGroup);
  const ensureInitialized = useTeamStore((state) => state.ensureInitialized);
  const syncFromSubagents = useTeamStore((state) => state.syncFromSubagents);
  const selectGroup = useTeamStore((state) => state.selectGroup);
  const createGroup = useTeamStore((state) => state.createGroup);
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
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [createGroupOpen, setCreateGroupOpen] = useState(false);
  const [createGroupTemplateId, setCreateGroupTemplateId] = useState<string | undefined>(undefined);
  const [botDialogOpen, setBotDialogOpen] = useState(false);
  const [editingBot, setEditingBot] = useState<TeamBot | undefined>(undefined);
  const [botCreateTarget, setBotCreateTarget] = useState<"library" | "create-group" | "active-group">("library");
  const [newlyCreatedBotId, setNewlyCreatedBotId] = useState<string | undefined>(undefined);
  const [serverPickerOpen, setServerPickerOpen] = useState(false);
  const [replyTo, setReplyTo] = useState<TeamMessage | undefined>(undefined);

  useEffect(() => {
    ensureInitialized((key) => t(key as Parameters<typeof t>[0]));
  }, [ensureInitialized, t]);

  useEffect(() => {
    syncFromSubagents(subagentProfiles);
  }, [subagentProfiles, syncFromSubagents]);

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

  const activeGroup = useMemo(
    () => groups.find((group) => group.id === activeGroupId) ?? groups[0],
    [groups, activeGroupId],
  );

  const activeMembers = useMemo(() => {
    if (!activeGroup) return [];
    return activeGroup.memberBotIds
      .map((id) => botsById.get(id))
      .filter((bot): bot is TeamBot => Boolean(bot));
  }, [activeGroup, botsById]);

  const activeMessages = activeGroup ? (messagesByGroup[activeGroup.id] ?? EMPTY_MESSAGES) : EMPTY_MESSAGES;
  const activeRuns = activeGroup ? (runsByGroup[activeGroup.id] ?? EMPTY_RUNS) : EMPTY_RUNS;
  const activePresence = activeGroup ? (presenceByGroup[activeGroup.id] ?? EMPTY_PRESENCE) : EMPTY_PRESENCE;

  // 切换群聊时清除未发出的回复引用。
  const handleSelectGroup = (groupId: string) => {
    setReplyTo(undefined);
    selectGroup(groupId);
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

  const handleSendMessage = (content: string, mentions: TeamMentionRef[]) => {
    if (!activeGroup) return;
    sendMessage({
      groupId: activeGroup.id,
      content,
      mentions,
      replyToMessageId: replyTo?.id,
      servers,
      labels: {
        localTarget: t("team.env.local"),
        smartTarget: t("team.env.smart"),
        coordinateStep: (name) => t("team.run.coordinateStep", { name }),
        mentionStep: (name) => t("team.run.mentionStep", { name }),
        awaitingNote: t("team.run.awaitingNote"),
      },
    });
  };

  return (
    <div className="team-shell">
      <TeamSidebar
        groups={groups}
        bots={bots}
        activeGroupId={activeGroup?.id}
        messagesByGroup={messagesByGroup}
        serversById={serversById}
        onSelectGroup={handleSelectGroup}
        onOpenCreateGroup={() => openCreateGroup()}
        onOpenCreateBot={() => openBotEditor("library")}
        onEditBot={(bot) => openBotEditor("library", bot)}
        onDeleteBot={(bot) => void handleDeleteBot(bot)}
        onDeleteGroup={(group) => void handleDeleteGroup(group)}
        onAddBotToActiveGroup={(botId) => {
          if (activeGroup) addMemberToGroup(activeGroup.id, botId);
        }}
      />

      <main className="team-stage">
        {activeGroup ? (
          <>
            <TeamChatHeader
              group={activeGroup}
              members={activeMembers}
              presence={activePresence}
              servers={servers}
              workspaces={workspaces}
              inspectorOpen={inspectorOpen}
              onToggleInspector={() => setInspectorOpen((prev) => !prev)}
              onUpdateGroup={(patch) => updateGroup(activeGroup.id, patch)}
              onOpenServerPicker={() => setServerPickerOpen(true)}
              onMentionBot={(bot) => composerRef.current?.insertMention(bot.name)}
              onOpenAddMember={() => setInspectorOpen(true)}
            />

            <TeamMessageList
              group={activeGroup}
              members={activeMembers}
              botsById={botsById}
              serversById={serversById}
              messages={activeMessages}
              runs={activeRuns}
              onReply={(message) => {
                setReplyTo(message);
                composerRef.current?.focus();
              }}
              onMentionBot={(bot) => composerRef.current?.insertMention(bot.name)}
              onQuickPrompt={(prompt) => composerRef.current?.setDraft(prompt)}
              onRunAction={(runId, action) => updateRunAction(activeGroup.id, runId, action)}
            />

            <TeamComposer
              ref={composerRef}
              group={activeGroup}
              members={activeMembers}
              servers={servers}
              replyTo={replyTo}
              replySenderName={replySenderName}
              onCancelReply={() => setReplyTo(undefined)}
              onSend={handleSendMessage}
              onOpenServerPicker={() => setServerPickerOpen(true)}
              onOpenCreateAndAddBot={() => openBotEditor("active-group")}
            />
          </>
        ) : (
          /* 首次进入团队模式的零门槛引导画布 */
          <div className="flex flex-1 flex-col items-center justify-center overflow-y-auto px-6 py-10">
            <div className="w-full max-w-[680px] text-center">
              <div className="mx-auto inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/50 px-3 py-1 text-xs text-muted-foreground">
                <Laptop size={12} />
                <span>{t("team.subtitle")}</span>
              </div>

              <h1 className="mt-4 text-2xl font-semibold tracking-tight text-foreground">
                {t("team.emptyGroupsTitle")}
              </h1>
              <p className="mx-auto mt-2 max-w-lg text-sm leading-relaxed text-muted-foreground">
                {t("team.emptyGroupsDesc")}
              </p>

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
                            <SubagentLogo key={bot.id} logo={bot.logo} name={bot.name} size={26} />
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

      <AnimatePresence initial={false}>
        {activeGroup && inspectorOpen && (
          <motion.div
            initial={{ width: 0, opacity: 0 }}
            animate={{ width: "auto", opacity: 1 }}
            exit={{ width: 0, opacity: 0 }}
            transition={{ duration: 0.18, ease: "easeOut" }}
            className="flex overflow-hidden"
          >
            <TeamInspector
              group={activeGroup}
              members={activeMembers}
              allBots={bots}
              botsById={botsById}
              serversById={serversById}
              runs={activeRuns}
              onClose={() => setInspectorOpen(false)}
              onUpdateGroup={(patch) => updateGroup(activeGroup.id, patch)}
              onAddMember={(botId) => addMemberToGroup(activeGroup.id, botId)}
              onRemoveMember={(botId) => removeMemberFromGroup(activeGroup.id, botId)}
              onEditBot={(bot) => openBotEditor("library", bot)}
              onOpenCreateBot={() => openBotEditor("active-group")}
              onOpenServerPicker={() => setServerPickerOpen(true)}
              onClearMessages={() => void handleClearMessages()}
              onRunAction={(runId, action) => updateRunAction(activeGroup.id, runId, action)}
            />
          </motion.div>
        )}
      </AnimatePresence>

      <CreateTeamGroupDialog
        open={createGroupOpen}
        onOpenChange={setCreateGroupOpen}
        bots={bots}
        servers={servers}
        workspaces={workspaces}
        initialTemplateId={createGroupTemplateId}
        newlyCreatedBotId={newlyCreatedBotId}
        onRequestCreateBot={() => openBotEditor("create-group")}
        onSubmit={handleCreateGroup}
      />

      <BotEditorDialog
        open={botDialogOpen}
        onOpenChange={setBotDialogOpen}
        editingBot={editingBot}
        modelConfigs={modelConfigs}
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
