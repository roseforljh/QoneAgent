import { create } from "zustand";
import { createJSONStorage, persist, type StateStorage } from "zustand/middleware";
import type { ServerInfo, SubagentProfileInfo } from "@qone/protocol";
import { instantiatePresetBots } from "./presets";
import type {
  TeamBot,
  TeamBotPresence,
  TeamChatMode,
  TeamExecutionConfig,
  TeamGroup,
  TeamMentionRef,
  TeamMessage,
  TeamRunCard,
  TeamRunStep,
  TeamRuntimeEvent,
  TeamTransport,
} from "./types";

const STORAGE_KEY = "qone-team-workspace-v1";

/** 无 DOM 测试环境下退化为内存存储，避免 persist 中间件报错。 */
const memoryStorage = new Map<string, string>();
const safeStorage: StateStorage = {
  getItem: (name) => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        return window.localStorage.getItem(name);
      }
    } catch {
      // 忽略受限存储环境异常
    }
    return memoryStorage.get(name) ?? null;
  },
  setItem: (name, value) => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.setItem(name, value);
        return;
      }
    } catch {
      // 忽略受限存储环境异常
    }
    memoryStorage.set(name, value);
  },
  removeItem: (name) => {
    try {
      if (typeof window !== "undefined" && window.localStorage) {
        window.localStorage.removeItem(name);
        return;
      }
    } catch {
      // 忽略受限存储环境异常
    }
    memoryStorage.delete(name);
  },
};

/** 可热插拔的运行时传输器；接入真实后端编排引擎时通过 setTeamTransport 注入。 */
let activeTransport: TeamTransport = {};

export function setTeamTransport(transport: TeamTransport): void {
  activeTransport = transport;
}

export interface CreateBotInput {
  name: string;
  roleTitle: string;
  description: string;
  systemPrompt: string;
  logo: TeamBot["logo"];
  modelId: string;
  capabilities: string[];
}

export interface CreateGroupInput {
  name: string;
  description: string;
  announcement?: string;
  memberBotIds: string[];
  coordinatorBotId: string;
  mode?: TeamChatMode;
  maxAutoRounds?: number;
  execution: TeamExecutionConfig;
}

export interface SendGroupMessageInput {
  groupId: string;
  content: string;
  mentions: TeamMentionRef[];
  replyToMessageId?: string;
  servers: readonly ServerInfo[];
  labels: {
    localTarget: string;
    smartTarget: string;
    coordinateStep: (coordinatorName: string) => string;
    mentionStep: (botName: string) => string;
    awaitingNote: string;
  };
}

interface TeamStoreState {
  initialized: boolean;
  bots: TeamBot[];
  groups: TeamGroup[];
  activeGroupId?: string;
  messagesByGroup: Record<string, TeamMessage[]>;
  runsByGroup: Record<string, TeamRunCard[]>;
  presenceByGroup: Record<string, Record<string, TeamBotPresence>>;

  ensureInitialized: (translate: (key: string) => string) => void;
  syncFromSubagents: (profiles: readonly SubagentProfileInfo[]) => void;

  selectGroup: (groupId: string) => void;
  createGroup: (input: CreateGroupInput) => TeamGroup;
  updateGroup: (groupId: string, patch: Partial<Omit<TeamGroup, "id" | "createdAt">>) => void;
  deleteGroup: (groupId: string) => void;
  clearGroupMessages: (groupId: string) => void;

  createBot: (input: CreateBotInput) => TeamBot;
  updateBot: (botId: string, patch: Partial<CreateBotInput>) => void;
  deleteBot: (botId: string) => void;
  addMemberToGroup: (groupId: string, botId: string) => void;
  removeMemberFromGroup: (groupId: string, botId: string) => void;

  sendMessage: (input: SendGroupMessageInput) => TeamMessage | null;
  updateRunAction: (groupId: string, runId: string, action: "pause" | "resume" | "cancel") => void;
  dispatchRuntimeEvent: (event: TeamRuntimeEvent) => void;
}

const uid = (prefix: string) => `${prefix}-${crypto.randomUUID()}`;

/** 规范化执行环境配置：未绑定服务器时保证本机启用且策略不会悬空。 */
export function normalizeExecutionConfig(config: TeamExecutionConfig): TeamExecutionConfig {
  const uniqueServers = [...new Set(config.serverIds.filter(Boolean))];
  if (uniqueServers.length === 0) {
    return {
      ...config,
      serverIds: [],
      allowLocal: true,
      strategy: config.strategy === "servers-preferred" ? "smart" : config.strategy,
    };
  }
  return {
    ...config,
    serverIds: uniqueServers,
    allowLocal: config.strategy === "local-only" ? true : config.allowLocal,
  };
}

/** 按群组路由策略与服务器状态推导状态卡上展示的目标环境标签。 */
function resolveStepTarget(
  execution: TeamExecutionConfig,
  servers: readonly ServerInfo[],
  labels: { localTarget: string; smartTarget: string },
): Pick<TeamRunStep, "targetKind" | "targetId" | "targetLabel"> {
  const bound = servers.filter((server) => execution.serverIds.includes(server.id));
  if (execution.strategy === "local-only" || bound.length === 0) {
    return { targetKind: "local", targetLabel: labels.localTarget };
  }
  if (execution.strategy === "servers-preferred") {
    const ready = bound.find((server) => server.status === "ready") ?? bound[0];
    return { targetKind: "server", targetId: ready.id, targetLabel: ready.name };
  }
  return { targetKind: "auto", targetLabel: labels.smartTarget };
}

export const useTeamStore = create<TeamStoreState>()(
  persist(
    (set, get) => ({
      initialized: false,
      bots: [],
      groups: [],
      activeGroupId: undefined,
      messagesByGroup: {},
      runsByGroup: {},
      presenceByGroup: {},

      ensureInitialized: (translate) => {
        const state = get();
        if (state.initialized && state.bots.length > 0) return;
        const now = Date.now();
        const presetBots = instantiatePresetBots(translate, now);
        const existingIds = new Set(state.bots.map((bot) => bot.id));
        const mergedBots = [...state.bots, ...presetBots.filter((bot) => !existingIds.has(bot.id))];
        set({
          initialized: true,
          bots: mergedBots,
          activeGroupId: state.activeGroupId ?? state.groups[0]?.id,
        });
      },

      syncFromSubagents: (profiles) => {
        if (!profiles.length) return;
        set((state) => {
          const nextBots = [...state.bots];
          let changed = false;
          for (const profile of profiles) {
            if (!profile.enabled) continue;
            const linkedId = `bot-subagent-${profile.id}`;
            const existingIndex = nextBots.findIndex((bot) => bot.id === linkedId || bot.linkedSubagentId === profile.id);
            const mapped: TeamBot = {
              id: linkedId,
              name: profile.name,
              roleTitle: profile.name,
              description: profile.instructions.slice(0, 120),
              systemPrompt: profile.instructions,
              logo: (profile.logo as TeamBot["logo"]) || "robot",
              modelId: profile.modelId ?? "",
              capabilities: profile.tools?.slice(0, 4) ?? [],
              source: "subagent",
              linkedSubagentId: profile.id,
              createdAt: profile.updatedAt || Date.now(),
              updatedAt: profile.updatedAt || Date.now(),
            };
            if (existingIndex === -1) {
              nextBots.push(mapped);
              changed = true;
            } else if (nextBots[existingIndex].updatedAt < mapped.updatedAt) {
              nextBots[existingIndex] = { ...nextBots[existingIndex], ...mapped };
              changed = true;
            }
          }
          return changed ? { bots: nextBots } : state;
        });
      },

      selectGroup: (groupId) => set({ activeGroupId: groupId }),

      createGroup: (input) => {
        const now = Date.now();
        const memberBotIds = [...new Set(input.memberBotIds)];
        const coordinatorBotId = memberBotIds.includes(input.coordinatorBotId)
          ? input.coordinatorBotId
          : memberBotIds[0] ?? "";
        const group: TeamGroup = {
          id: uid("team-group"),
          name: input.name.trim(),
          description: input.description.trim(),
          announcement: input.announcement?.trim() ?? "",
          memberBotIds,
          coordinatorBotId,
          mode: input.mode ?? "execute",
          maxAutoRounds: input.maxAutoRounds ?? 6,
          execution: normalizeExecutionConfig(input.execution),
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({
          groups: [group, ...state.groups],
          activeGroupId: group.id,
          messagesByGroup: { ...state.messagesByGroup, [group.id]: [] },
          runsByGroup: { ...state.runsByGroup, [group.id]: [] },
        }));
        return group;
      },

      updateGroup: (groupId, patch) => {
        set((state) => ({
          groups: state.groups.map((group) => {
            if (group.id !== groupId) return group;
            const nextExecution = patch.execution
              ? normalizeExecutionConfig(patch.execution)
              : group.execution;
            const nextMembers = patch.memberBotIds ? [...new Set(patch.memberBotIds)] : group.memberBotIds;
            const requestedCoordinator = patch.coordinatorBotId ?? group.coordinatorBotId;
            const nextCoordinator = nextMembers.includes(requestedCoordinator)
              ? requestedCoordinator
              : nextMembers[0] ?? "";
            return {
              ...group,
              ...patch,
              memberBotIds: nextMembers,
              coordinatorBotId: nextCoordinator,
              execution: nextExecution,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      deleteGroup: (groupId) => {
        set((state) => {
          const nextGroups = state.groups.filter((group) => group.id !== groupId);
          const { [groupId]: _m, ...nextMessages } = state.messagesByGroup;
          const { [groupId]: _r, ...nextRuns } = state.runsByGroup;
          const { [groupId]: _p, ...nextPresence } = state.presenceByGroup;
          return {
            groups: nextGroups,
            activeGroupId: state.activeGroupId === groupId ? nextGroups[0]?.id : state.activeGroupId,
            messagesByGroup: nextMessages,
            runsByGroup: nextRuns,
            presenceByGroup: nextPresence,
          };
        });
      },

      clearGroupMessages: (groupId) => {
        set((state) => ({
          messagesByGroup: { ...state.messagesByGroup, [groupId]: [] },
          runsByGroup: { ...state.runsByGroup, [groupId]: [] },
          presenceByGroup: { ...state.presenceByGroup, [groupId]: {} },
        }));
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
          modelId: input.modelId,
          capabilities: [...new Set(input.capabilities.map((item) => item.trim()).filter(Boolean))],
          source: "custom",
          createdAt: now,
          updatedAt: now,
        };
        set((state) => ({ bots: [...state.bots, bot] }));
        return bot;
      },

      updateBot: (botId, patch) => {
        set((state) => ({
          bots: state.bots.map((bot) =>
            bot.id === botId
              ? {
                  ...bot,
                  ...patch,
                  name: patch.name !== undefined ? patch.name.trim() : bot.name,
                  roleTitle: patch.roleTitle !== undefined ? patch.roleTitle.trim() : bot.roleTitle,
                  description: patch.description !== undefined ? patch.description.trim() : bot.description,
                  systemPrompt: patch.systemPrompt !== undefined ? patch.systemPrompt.trim() : bot.systemPrompt,
                  updatedAt: Date.now(),
                }
              : bot,
          ),
        }));
      },

      deleteBot: (botId) => {
        set((state) => ({
          bots: state.bots.filter((bot) => bot.id !== botId),
          groups: state.groups.map((group) => {
            if (!group.memberBotIds.includes(botId)) return group;
            const nextMembers = group.memberBotIds.filter((id) => id !== botId);
            return {
              ...group,
              memberBotIds: nextMembers,
              coordinatorBotId:
                group.coordinatorBotId === botId ? (nextMembers[0] ?? "") : group.coordinatorBotId,
              updatedAt: Date.now(),
            };
          }),
        }));
      },

      addMemberToGroup: (groupId, botId) => {
        const group = get().groups.find((item) => item.id === groupId);
        if (!group || group.memberBotIds.includes(botId)) return;
        get().updateGroup(groupId, { memberBotIds: [...group.memberBotIds, botId] });
      },

      removeMemberFromGroup: (groupId, botId) => {
        const group = get().groups.find((item) => item.id === groupId);
        if (!group || group.memberBotIds.length <= 1) return;
        get().updateGroup(groupId, {
          memberBotIds: group.memberBotIds.filter((id) => id !== botId),
        });
      },

      sendMessage: ({ groupId, content, mentions, replyToMessageId, servers, labels }) => {
        const trimmed = content.trim();
        if (!trimmed) return null;
        const state = get();
        const group = state.groups.find((item) => item.id === groupId);
        if (!group) return null;

        const now = Date.now();
        const messageId = uid("team-msg");
        const runId = uid("team-run");

        const message: TeamMessage = {
          id: messageId,
          groupId,
          senderKind: "user",
          content: trimmed,
          mentions,
          replyToMessageId,
          runCardId: runId,
          mode: group.mode,
          createdAt: now,
        };

        // 依据实际 @ 提及或群统筹生成结构化执行计划卡，不做任何硬编码假回复。
        const groupBots = group.memberBotIds
          .map((id) => state.bots.find((bot) => bot.id === id))
          .filter((bot): bot is TeamBot => Boolean(bot));
        const coordinator =
          groupBots.find((bot) => bot.id === group.coordinatorBotId) ?? groupBots[0];
        const target = resolveStepTarget(group.execution, servers, labels);
        const mentionedAll = mentions.some((item) => item.kind === "all");
        const mentionedBots = mentionedAll
          ? groupBots
          : mentions
              .filter((item) => item.kind === "bot")
              .map((item) => groupBots.find((bot) => bot.id === item.targetId))
              .filter((bot): bot is TeamBot => Boolean(bot));

        const steps: TeamRunStep[] = mentionedBots.length > 0
          ? mentionedBots.map((bot) => ({
              id: uid("team-step"),
              title: labels.mentionStep(bot.name),
              botId: bot.id,
              status: activeTransport.sendGroupMessage ? "pending" : "awaiting",
              ...target,
            }))
          : coordinator
            ? [
                {
                  id: uid("team-step"),
                  title: labels.coordinateStep(coordinator.name),
                  botId: coordinator.id,
                  status: activeTransport.sendGroupMessage ? "pending" : "awaiting",
                  ...target,
                },
              ]
            : [];

        const run: TeamRunCard = {
          id: runId,
          groupId,
          triggerMessageId: messageId,
          title: trimmed.length > 56 ? `${trimmed.slice(0, 56)}…` : trimmed,
          coordinatorBotId: coordinator?.id ?? "",
          status: activeTransport.sendGroupMessage ? "queued" : "awaiting_runtime",
          mode: group.mode,
          strategy: group.execution.strategy,
          targetServerIds: [...group.execution.serverIds],
          allowLocal: group.execution.allowLocal,
          steps,
          startedAt: now,
          updatedAt: now,
          note: activeTransport.sendGroupMessage ? undefined : labels.awaitingNote,
        };

        set((current) => ({
          messagesByGroup: {
            ...current.messagesByGroup,
            [groupId]: [...(current.messagesByGroup[groupId] ?? []), message],
          },
          runsByGroup: {
            ...current.runsByGroup,
            [groupId]: [...(current.runsByGroup[groupId] ?? []), run],
          },
          groups: current.groups.map((item) =>
            item.id === groupId ? { ...item, updatedAt: now } : item,
          ),
        }));

        if (activeTransport.sendGroupMessage) {
          void activeTransport.sendGroupMessage({ group, message, run, bots: groupBots });
        }

        return message;
      },

      updateRunAction: (groupId, runId, action) => {
        const now = Date.now();
        set((state) => ({
          runsByGroup: {
            ...state.runsByGroup,
            [groupId]: (state.runsByGroup[groupId] ?? []).map((run) => {
              if (run.id !== runId) return run;
              if (action === "pause") {
                return {
                  ...run,
                  status: "paused",
                  updatedAt: now,
                  steps: run.steps.map((step) =>
                    step.status === "running" || step.status === "pending"
                      ? { ...step, status: "paused" }
                      : step,
                  ),
                };
              }
              if (action === "resume") {
                return {
                  ...run,
                  status: activeTransport.sendGroupMessage ? "running" : "awaiting_runtime",
                  updatedAt: now,
                  steps: run.steps.map((step) =>
                    step.status === "paused"
                      ? { ...step, status: activeTransport.sendGroupMessage ? "pending" : "awaiting" }
                      : step,
                  ),
                };
              }
              return {
                ...run,
                status: "cancelled",
                updatedAt: now,
                finishedAt: now,
                steps: run.steps.map((step) =>
                  step.status === "running" || step.status === "pending" || step.status === "paused" || step.status === "awaiting"
                    ? { ...step, status: "paused" }
                    : step,
                ),
              };
            }),
          },
        }));
        void activeTransport.updateRunStatus?.(runId, action);
      },

      dispatchRuntimeEvent: (event) => {
        if (event.type === "team.message.append") {
          set((state) => ({
            messagesByGroup: {
              ...state.messagesByGroup,
              [event.message.groupId]: [
                ...(state.messagesByGroup[event.message.groupId] ?? []),
                event.message,
              ],
            },
          }));
          return;
        }
        if (event.type === "team.run.upsert") {
          set((state) => {
            const list = state.runsByGroup[event.run.groupId] ?? [];
            const exists = list.some((item) => item.id === event.run.id);
            return {
              runsByGroup: {
                ...state.runsByGroup,
                [event.run.groupId]: exists
                  ? list.map((item) => (item.id === event.run.id ? event.run : item))
                  : [...list, event.run],
              },
            };
          });
          return;
        }
        if (event.type === "team.bot.presence") {
          set((state) => ({
            presenceByGroup: {
              ...state.presenceByGroup,
              [event.groupId]: {
                ...(state.presenceByGroup[event.groupId] ?? {}),
                [event.botId]: event.presence,
              },
            },
          }));
        }
      },
    }),
    {
      name: STORAGE_KEY,
      storage: createJSONStorage(() => safeStorage),
      partialize: (state) => ({
        initialized: state.initialized,
        bots: state.bots,
        groups: state.groups,
        activeGroupId: state.activeGroupId,
        messagesByGroup: state.messagesByGroup,
        runsByGroup: state.runsByGroup,
      }),
    },
  ),
);
