import { create } from "zustand";
import { normalizeTeamExecution, type MessageAttachmentInfo, type TeamRunDefaults } from "@qone/protocol";
import { instantiatePresetBots } from "./presets";
import type {
  TeamBot,
  TeamBotPresence,
  TeamChatMode,
  TeamApprovalCommandInput,
  TeamCommandInput,
  TeamExecutionConfig,
  TeamGroup,
  TeamMentionRef,
  TeamMessage,
  TeamRunAction,
  TeamRunCard,
  TeamRuntimeEvent,
  TeamStateSnapshot,
  TeamTransport,
} from "./types";

/** 旧版纯前端持久化的数据键；首次连上后端且团队表为空时导入一次后删除。 */
const LEGACY_STORAGE_KEY = "qone-team-workspace-v1";
const ACTIVE_GROUP_KEY = "qone-team-active-group";

function storage(): Storage | undefined {
  try {
    return typeof window !== "undefined" ? window.localStorage : undefined;
  } catch {
    return undefined;
  }
}

/** 运行时传输器：由 store-bridge 注入基于运行时连接的实现。 */
let activeTransport: TeamTransport | undefined;

export function setTeamTransport(transport: TeamTransport | undefined): void {
  activeTransport = transport;
}

function sendTeam(command: TeamCommandInput | TeamApprovalCommandInput) {
  void activeTransport?.send(command);
}

export interface CreateBotInput {
  name: string;
  roleTitle: string;
  description: string;
  systemPrompt: string;
  logo: TeamBot["logo"];
  avatar?: string;
  modelId: string;
  thinking?: TeamBot["thinking"];
  capabilities: string[];
}

export interface CreateGroupInput {
  name: string;
  description: string;
  announcement?: string;
  avatar?: string;
  memberBotIds: string[];
  coordinatorBotId: string;
  directBotId?: string;
  mode?: TeamChatMode;
  maxAutoRounds?: number;
  execution: TeamExecutionConfig;
}

export interface SendGroupMessageInput {
  groupId: string;
  content: string;
  mentions: TeamMentionRef[];
  attachments?: MessageAttachmentInfo[];
  replyToMessageId?: string;
  /** 沿用当前全局模型、权限模式与活跃项目。 */
  defaults?: TeamRunDefaults;
}

interface TeamStoreState {
  /** 已收到后端全量状态。 */
  loaded: boolean;
  bots: TeamBot[];
  groups: TeamGroup[];
  activeGroupId?: string;
  messagesByGroup: Record<string, TeamMessage[]>;
  runsByGroup: Record<string, TeamRunCard[]>;
  presenceByGroup: Record<string, Record<string, TeamBotPresence>>;

  ensurePresets: (translate: (key: string) => string) => void;

  selectGroup: (groupId: string) => void;
  createGroup: (input: CreateGroupInput) => TeamGroup;
  openDirectChat: (bot: TeamBot) => void;
  updateGroup: (groupId: string, patch: Partial<Omit<TeamGroup, "id" | "createdAt" | "directBotId">>) => void;
  deleteGroup: (groupId: string) => void;
  clearGroupMessages: (groupId: string) => void;

  createBot: (input: CreateBotInput) => TeamBot;
  updateBot: (botId: string, patch: Partial<CreateBotInput>) => void;
  deleteBot: (botId: string) => void;
  addMemberToGroup: (groupId: string, botId: string) => void;
  removeMemberFromGroup: (groupId: string, botId: string) => void;

  sendMessage: (input: SendGroupMessageInput) => TeamMessage | null;
  updateRunAction: (runId: string, action: TeamRunAction) => void;
  resolveApproval: (approvalId: string, approved: boolean) => void;
  dispatchRuntimeEvent: (event: TeamRuntimeEvent) => void;
}

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** 群成员去重、统筹必须是成员、执行环境按共享规则规范化。 */
function normalizeGroup(group: TeamGroup): TeamGroup {
  const memberBotIds = [...new Set(group.memberBotIds)];
  const coordinatorBotId = memberBotIds.includes(group.coordinatorBotId) ? group.coordinatorBotId : memberBotIds[0] ?? "";
  return { ...group, memberBotIds, coordinatorBotId, execution: normalizeTeamExecution(group.execution) };
}

function groupBy<T extends { groupId: string }>(items: readonly T[]): Record<string, T[]> {
  const result: Record<string, T[]> = {};
  for (const item of items) {
    result[item.groupId] ??= [];
    result[item.groupId].push(item);
  }
  return result;
}

function upsertById<T extends { id: string }>(list: readonly T[] | undefined, item: T): T[] {
  const current = list ?? [];
  const index = current.findIndex((entry) => entry.id === item.id);
  if (index === -1) return [...current, item];
  const next = [...current];
  next[index] = item;
  return next;
}

/** 读取旧版 localStorage 数据并转换为后端导入格式。 */
function readLegacyState(): Omit<TeamStateSnapshot, "presence"> | undefined {
  const raw = storage()?.getItem(LEGACY_STORAGE_KEY);
  if (!raw) return undefined;
  try {
    const state = (JSON.parse(raw) as { state?: Record<string, unknown> }).state ?? {};
    const bots = Array.isArray(state.bots) ? (state.bots as TeamBot[]) : [];
    const groups = Array.isArray(state.groups) ? (state.groups as TeamGroup[]) : [];
    const flatten = <T,>(value: unknown) => Object.values((value ?? {}) as Record<string, T[]>).flat();
    const messages = flatten<TeamMessage>(state.messagesByGroup);
    const runs = flatten<TeamRunCard>(state.runsByGroup);
    return bots.length || groups.length ? { bots, groups, messages, runs } : undefined;
  } catch {
    return undefined;
  }
}

function applySnapshot(state: TeamStateSnapshot, activeGroupId: string | undefined) {
  return {
    loaded: true,
    bots: state.bots,
    groups: state.groups,
    messagesByGroup: groupBy(state.messages),
    runsByGroup: groupBy(state.runs),
    presenceByGroup: state.presence,
    activeGroupId: state.groups.some((group) => group.id === activeGroupId) ? activeGroupId : state.groups[0]?.id,
  };
}

/**
 * 团队模式前端状态：后端运行时是唯一数据源，本地只做乐观更新与事件合并。
 * 所有写操作经 TeamTransport 发给后端，后端广播的全量/增量事件覆盖本地状态。
 */
export const useTeamStore = create<TeamStoreState>()((set, get) => ({
  loaded: false,
  bots: [],
  groups: [],
  activeGroupId: storage()?.getItem(ACTIVE_GROUP_KEY) ?? undefined,
  messagesByGroup: {},
  runsByGroup: {},
  presenceByGroup: {},

  ensurePresets: (translate) => {
    const state = get();
    if (!state.loaded) return;
    const existing = new Set(state.bots.map((bot) => bot.id));
    const missing = instantiatePresetBots(translate).filter((bot) => !existing.has(bot.id));
    if (!missing.length) return;
    set({ bots: [...state.bots, ...missing] });
    for (const bot of missing) sendTeam({ type: "team.bot.save", bot });
  },

  selectGroup: (groupId) => {
    storage()?.setItem(ACTIVE_GROUP_KEY, groupId);
    set({ activeGroupId: groupId });
  },

  createGroup: (input) => {
    const now = Date.now();
    const group = normalizeGroup({
      id: uid("team-group"),
      name: input.name.trim(),
      description: input.description.trim(),
      announcement: input.announcement?.trim() ?? "",
      ...(input.avatar ? { avatar: input.avatar } : {}),
      memberBotIds: input.memberBotIds,
      coordinatorBotId: input.coordinatorBotId,
      ...(input.directBotId ? { directBotId: input.directBotId } : {}),
      mode: input.mode ?? "execute",
      maxAutoRounds: input.maxAutoRounds ?? 50,
      execution: input.execution,
      createdAt: now,
      updatedAt: now,
    });
    set((state) => ({ groups: [group, ...state.groups] }));
    get().selectGroup(group.id);
    sendTeam({ type: "team.group.create", group });
    return group;
  },

  openDirectChat: (bot) => {
    const existing = get().groups.find((group) => group.directBotId === bot.id);
    if (existing) {
      get().selectGroup(existing.id);
      return;
    }
    get().createGroup({
      name: bot.name,
      description: "",
      directBotId: bot.id,
      memberBotIds: [bot.id],
      coordinatorBotId: bot.id,
      execution: { allowLocal: true, serverIds: [], strategy: "smart" },
    });
  },

  updateGroup: (groupId, patch) => {
    const current = get().groups.find((group) => group.id === groupId);
    if (!current) return;
    const roster = current.directBotId ? { memberBotIds: current.memberBotIds, coordinatorBotId: current.coordinatorBotId } : {};
    const next = normalizeGroup({ ...current, ...patch, ...roster, updatedAt: Date.now() });
    set((state) => ({ groups: state.groups.map((group) => (group.id === groupId ? next : group)) }));
    const { id: _id, createdAt: _createdAt, directBotId: _directBotId, ...fields } = next;
    sendTeam({ type: "team.group.update", groupId, patch: fields });
  },

  deleteGroup: (groupId) => {
    set((state) => {
      const groups = state.groups.filter((group) => group.id !== groupId);
      return { groups, activeGroupId: state.activeGroupId === groupId ? groups[0]?.id : state.activeGroupId };
    });
    sendTeam({ type: "team.group.delete", groupId });
  },

  clearGroupMessages: (groupId) => {
    set((state) => ({
      messagesByGroup: { ...state.messagesByGroup, [groupId]: [] },
      runsByGroup: { ...state.runsByGroup, [groupId]: [] },
      presenceByGroup: { ...state.presenceByGroup, [groupId]: {} },
    }));
    sendTeam({ type: "team.group.clear", groupId });
  },

  createBot: (input) => {
    const now = Date.now();
    const bot: TeamBot = {
      id: uid("bot-custom"),
      name: input.name.trim(),
      roleTitle: input.roleTitle.trim(),
      description: input.description.trim(),
      systemPrompt: input.systemPrompt.trim(),
      logo: input.logo,
      ...(input.avatar ? { avatar: input.avatar } : {}),
      modelId: input.modelId,
      ...(input.thinking ? { thinking: input.thinking } : {}),
      capabilities: [...new Set(input.capabilities.map((item) => item.trim()).filter(Boolean))],
      source: "custom",
      createdAt: now,
      updatedAt: now,
    };
    set((state) => ({ bots: [...state.bots, bot] }));
    sendTeam({ type: "team.bot.save", bot });
    return bot;
  },

  updateBot: (botId, patch) => {
    const current = get().bots.find((bot) => bot.id === botId);
    if (!current) return;
    const bot: TeamBot = {
      ...current,
      ...patch,
      name: (patch.name ?? current.name).trim(),
      roleTitle: (patch.roleTitle ?? current.roleTitle).trim(),
      description: (patch.description ?? current.description).trim(),
      systemPrompt: (patch.systemPrompt ?? current.systemPrompt).trim(),
      updatedAt: Date.now(),
    };
    set((state) => ({ bots: upsertById(state.bots, bot) }));
    sendTeam({ type: "team.bot.save", bot });
  },

  deleteBot: (botId) => {
    set((state) => ({
      bots: state.bots.filter((bot) => bot.id !== botId),
      groups: state.groups.map((group) =>
        group.memberBotIds.includes(botId)
          ? normalizeGroup({ ...group, memberBotIds: group.memberBotIds.filter((id) => id !== botId) })
          : group,
      ),
    }));
    sendTeam({ type: "team.bot.delete", botId });
  },

  addMemberToGroup: (groupId, botId) => {
    const group = get().groups.find((item) => item.id === groupId);
    if (!group || group.directBotId || group.memberBotIds.includes(botId)) return;
    get().updateGroup(groupId, { memberBotIds: [...group.memberBotIds, botId] });
  },

  removeMemberFromGroup: (groupId, botId) => {
    const group = get().groups.find((item) => item.id === groupId);
    if (!group || group.memberBotIds.length <= 1) return;
    get().updateGroup(groupId, { memberBotIds: group.memberBotIds.filter((id) => id !== botId) });
  },

  sendMessage: ({ groupId, content, mentions, attachments, replyToMessageId, defaults }) => {
    const trimmed = content.trim();
    const attached = attachments?.length ? attachments : undefined;
    const group = get().groups.find((item) => item.id === groupId);
    if ((!trimmed && !attached) || !group || (group.directBotId && !group.memberBotIds.length)) return null;
    const message: TeamMessage = {
      id: uid("team-msg"),
      groupId,
      senderKind: "user",
      content: trimmed,
      mentions,
      ...(attached ? { attachments: attached } : {}),
      replyToMessageId,
      mode: group.mode,
      createdAt: Date.now(),
    };
    // 乐观追加用户消息；后端以同一 ID 回推带运行卡片的正式消息。
    set((state) => ({
      messagesByGroup: { ...state.messagesByGroup, [groupId]: upsertById(state.messagesByGroup[groupId], message) },
    }));
    sendTeam({
      type: "team.message.send",
      groupId,
      messageId: message.id,
      content: trimmed,
      mentions,
      ...(attached ? { attachments: attached } : {}),
      ...(replyToMessageId ? { replyToMessageId } : {}),
      mode: group.mode,
      ...(defaults ? { defaults } : {}),
    });
    return message;
  },

  updateRunAction: (runId, action) => {
    sendTeam({ type: "team.run.action", runId, action });
  },

  resolveApproval: (approvalId, approved) => {
    sendTeam(approved ? { type: "tool.approve", approvalId } : { type: "tool.reject", approvalId });
  },

  dispatchRuntimeEvent: (event) => {
    if (event.type === "team.state") {
      const { state } = event;
      const empty = !state.bots.length && !state.groups.length && !state.messages.length && !state.runs.length;
      const legacy = empty ? readLegacyState() : undefined;
      if (legacy) {
        // 承接旧版本地数据：交给后端导入，导入完成后的全量状态再落到界面。
        storage()?.removeItem(LEGACY_STORAGE_KEY);
        sendTeam({ type: "team.state.import", state: legacy });
        return;
      }
      set((current) => applySnapshot(state, current.activeGroupId));
      return;
    }
    if (event.type === "team.message.append") {
      const { message } = event;
      set((state) => ({
        messagesByGroup: { ...state.messagesByGroup, [message.groupId]: upsertById(state.messagesByGroup[message.groupId], message) },
      }));
      return;
    }
    if (event.type === "team.message.delta") {
      set((state) => {
        const list = state.messagesByGroup[event.groupId];
        const index = list?.findIndex((message) => message.id === event.messageId) ?? -1;
        if (!list || index === -1) return state;
        const next = [...list];
        next[index] = { ...next[index], content: next[index].content + event.delta };
        return { messagesByGroup: { ...state.messagesByGroup, [event.groupId]: next } };
      });
      return;
    }
    if (event.type === "team.run.upsert") {
      const { run } = event;
      set((state) => ({ runsByGroup: { ...state.runsByGroup, [run.groupId]: upsertById(state.runsByGroup[run.groupId], run) } }));
      return;
    }
    set((state) => ({
      presenceByGroup: {
        ...state.presenceByGroup,
        [event.groupId]: { ...(state.presenceByGroup[event.groupId] ?? {}), [event.botId]: event.presence },
      },
    }));
  },
}));
