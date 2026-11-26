import type { ModelConfigInfo, RuntimeLocale, TeamBot, TeamGroup, TeamMentionRef, TeamMessage, TeamRunDefaults } from "@qone/protocol";
import { runtimeText } from "../runtime-localization.js";
import { expectedTarget, type TeamExecutionScope } from "./team-environment.js";
import { oneLine, type TeamRunRecord, type TeamStepRecord } from "./team-records.js";

export interface TeamRoute {
  route: TeamRunRecord["route"];
  /** 按群成员或提及顺序保存本次消息的接收者。 */
  botIds: string[];
}

/**
 * 仅明确 @全体成员 时由所有成员并发响应；无 @ 或只 @统筹 时默认交给群统筹回复与分工。
 * 私聊始终只有一位接收者；提及只认结构化引用，不解析正文关键词。
 */
export function routeMessage(group: TeamGroup, bots: readonly TeamBot[], mentions: readonly TeamMentionRef[]): TeamRoute {
  const members = group.memberBotIds.filter((id) => bots.some((bot) => bot.id === id));
  const coordinator = members.includes(group.coordinatorBotId) ? group.coordinatorBotId : members[0];
  if (group.directBotId) return { route: "mentions", botIds: members.filter((id) => id === group.directBotId) };
  if (mentions.some((mention) => mention.kind === "all")) return { route: "all", botIds: members };
  const mentioned = [...new Set(mentions.filter((mention) => mention.kind === "bot").map((mention) => mention.targetId))]
    .filter((id) => members.includes(id));
  if (mentioned.length && !(mentioned.length === 1 && mentioned[0] === coordinator)) return { route: "mentions", botIds: mentioned };
  return { route: "coordinator", botIds: coordinator ? [coordinator] : [] };
}

export interface CreateRunInput {
  id: string;
  group: TeamGroup;
  bots: readonly TeamBot[];
  message: TeamMessage;
  defaults: TeamRunDefaults;
  locale?: RuntimeLocale;
  /** 用于推导步骤预期环境（只需策略与服务器列表）。 */
  scope: TeamExecutionScope;
  now: number;
}

const stepTitle = (key: "team.step.plan" | "team.step.respond" | "team.step.summary", bot: TeamBot | undefined) => runtimeText(key, { name: bot?.name ?? "" });

export function summaryStep(coordinator: TeamBot, dependsOn: string[], scope: TeamExecutionScope): TeamStepRecord {
  return { id: "summary", kind: "summary", botId: coordinator.id, title: stepTitle("team.step.summary", coordinator), status: "pending", dependsOn, attempts: 0, ...expectedTarget({ ...scope, servers: [] }) };
}

/** 生成初始步骤：全员投递不是自动派工，人数不受协作轮次截断。 */
export function createRunRecord(input: CreateRunInput): TeamRunRecord {
  const { group, bots, message, scope, now } = input;
  const mode = message.mode ?? group.mode;
  const byId = new Map(bots.map((bot) => [bot.id, bot]));
  const route = routeMessage(group, bots, message.mentions);
  const coordinator = byId.get(route.route === "coordinator" ? route.botIds[0] ?? "" : group.coordinatorBotId);
  const titleSource = message.content || message.attachments?.map((item) => item.name).join(", ") || "";
  const base: TeamRunRecord = {
    id: input.id, groupId: group.id, triggerMessageId: message.id, title: oneLine(titleSource, 56),
    coordinatorBotId: coordinator?.id ?? "", status: "planning", mode, strategy: scope.strategy,
    targetServerIds: scope.servers.map((server) => server.id), allowLocal: scope.localWrite, steps: [],
    startedAt: now, updatedAt: now, maxAutoRounds: group.maxAutoRounds,
    route: route.route, phase: "planning", prompt: message.content,
    ...(message.attachments?.length ? { attachments: message.attachments } : {}),
    confirmed: false, roundsUsed: 0,
    defaults: input.defaults, ...(input.locale ? { locale: input.locale } : {}),
  };
  if (!route.botIds.length) return { ...base, status: "failed", phase: "done", finishedAt: now, note: runtimeText("team.note.no_members") };
  if (route.route === "coordinator") {
    return { ...base, steps: [{ id: "plan", kind: "plan", botId: coordinator!.id, title: stepTitle("team.step.plan", coordinator), status: "pending", dependsOn: [], attempts: 0, ...expectedTarget({ ...scope, servers: [] }) }] };
  }
  const allowed = route.route === "all" ? route.botIds : route.botIds.slice(0, group.maxAutoRounds);
  const steps: TeamStepRecord[] = allowed.map((botId, index) => ({
    id: `r${index + 1}`, kind: "respond", botId, title: stepTitle("team.step.respond", byId.get(botId)),
    status: "pending", dependsOn: [], attempts: 0, ...expectedTarget(scope),
  }));
  if (route.route === "mentions" && steps.length > 1 && coordinator) steps.push(summaryStep(coordinator, steps.map((step) => step.id), scope));
  const dropped = route.botIds.length - allowed.length;
  return {
    ...base, status: "running", phase: mode === "plan" ? "proposing" : "executing", steps,
    ...(dropped > 0 ? { note: runtimeText("team.note.rounds_limited", { max: group.maxAutoRounds, count: dropped }) } : {}),
  };
}

/**
 * 成员模型：机器人自己的 modelId → 本次发送沿用的全局选择 → 第一个可用对话模型。
 * 已删除、停用或不能对话的模型会被跳过，不会把请求发给不存在的模型。
 */
export function resolveBotModel(bot: Pick<TeamBot, "modelId">, defaults: TeamRunDefaults, configs: readonly ModelConfigInfo[], canChat: (config: ModelConfigInfo) => boolean): string | undefined {
  const usable = configs.filter((config) => config.enabled && canChat(config));
  const pick = (id?: string) => id ? usable.find((config) => config.id === id || `${config.provider}/${config.model}` === id) : undefined;
  return (pick(bot.modelId) ?? pick(defaults.model) ?? usable[0])?.id;
}
