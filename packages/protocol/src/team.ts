import { z } from "zod";
import { messageAttachmentSchema, nonMediaAttachmentBytes } from "./attachments";
import type { MessageAttachmentInfo, SubagentLogoId } from "./index";

/** 团队执行路由策略：默认允许在“本机”与已绑定服务器间按任务意图智能调度。 */
export type TeamExecutionStrategy = "smart" | "local-only" | "servers-preferred";

/** 群聊协作模式：执行模式可直接调度工具，规划模式仅产出方案待确认。 */
export type TeamChatMode = "execute" | "plan";

/** 单个机器人当前在群内的可视化状态。 */
export type TeamBotPresence = "idle" | "thinking" | "working" | "waiting";

export type TeamThinkingLevel = "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

/** 团队成员分预设与自定义；subagent 仅用于读取旧版同步记录。 */
export type TeamBotSource = "preset" | "subagent" | "custom";

/** 团队机器人的通用定义，不耦合任何具体模型厂商或后端实现。 */
export interface TeamBot {
  id: string;
  name: string;
  roleTitle: string;
  description: string;
  systemPrompt: string;
  logo: SubagentLogoId;
  /** 空字符串表示跟随全局默认模型。 */
  modelId: string;
  /** 所选模型的推理强度；跟随全局模型时不生效。 */
  thinking?: TeamThinkingLevel;
  /** 内置头像 ID 或裁剪后的图片 Data URL；兼容旧头像种子和空值。 */
  avatar?: string;
  capabilities: string[];
  source: TeamBotSource;
  /** 仅当 source === "preset" 时用于绑定模板预设键。 */
  presetKey?: string;
  /** 旧版同步记录关联过的独立子代理 ID。 */
  linkedSubagentId?: string;
  createdAt: number;
  updatedAt: number;
}

/** 群聊绑定的执行环境配置：本机始终可用，服务器可按需绑定 0~N 台。 */
export interface TeamExecutionConfig {
  /** 本机环境开关；未绑定服务器时自动保持为 true。 */
  allowLocal: boolean;
  /** 已绑定的远程 SSH 服务器 ID 列表。 */
  serverIds: string[];
  /** 任务路由策略。 */
  strategy: TeamExecutionStrategy;
  /** 可选绑定的本地项目工作区 ID。 */
  workspaceId?: string;
}

/** 单条消息中解析出的 @ 提及信息。 */
export interface TeamMentionRef {
  kind: "all" | "bot";
  /** kind === "all" 时为 "all"，否则为对应机器人 ID。 */
  targetId: string;
  label: string;
}

/** 步骤实际使用过的执行环境（由运行时真实工具结果回填）。 */
export interface TeamStepTarget {
  kind: "local" | "server";
  id?: string;
  label?: string;
}

/** 步骤上等待用户处理的工具审批。 */
export interface TeamStepApproval {
  approvalId: string;
  toolName: string;
  /** 便于卡片展示的参数摘要（命令或路径）。 */
  detail?: string;
}

export interface TeamToolActivity {
  id?: string;
  tool: string;
  detail?: string;
  outcome: "running" | "done" | "failed" | "blocked";
}

/** 步骤种类：统筹规划、成员工作、独立验收、被 @ 成员直接响应、统筹汇总。 */
export type TeamStepKind = "plan" | "work" | "verify" | "respond" | "summary";

/** Agent 运行状态卡的单步执行项。 */
export interface TeamRunStep {
  id: string;
  kind?: TeamStepKind;
  title: string;
  botId: string;
  status: "pending" | "running" | "completed" | "failed" | "paused" | "awaiting";
  /** 该步骤解析后的执行环境：执行前为路由预期，执行后为真实使用的环境。 */
  targetKind: "local" | "server" | "auto";
  targetId?: string;
  targetLabel?: string;
  /** 本步骤真实调用过的全部执行环境。 */
  targets?: TeamStepTarget[];
  /** 统筹分派给该成员的具体任务说明。 */
  instruction?: string;
  summary?: string;
  approval?: TeamStepApproval;
  activity?: TeamToolActivity[];
  /** 本步骤对应的机器人回复消息 ID，用于前端将执行卡片精准嵌入对应气泡内。 */
  messageId?: string;
  startedAt?: number;
  finishedAt?: number;
}

export type TeamRunStatus =
  | "queued" | "planning" | "running" | "paused" | "completed" | "failed" | "cancelled"
  | "awaiting_runtime" | "awaiting_confirmation";

/** 团队运行侧栏的状态卡。 */
export interface TeamRunCard {
  id: string;
  groupId: string;
  triggerMessageId: string;
  title: string;
  coordinatorBotId: string;
  status: TeamRunStatus;
  mode: TeamChatMode;
  strategy: TeamExecutionStrategy;
  targetServerIds: string[];
  allowLocal: boolean;
  steps: TeamRunStep[];
  startedAt: number;
  updatedAt: number;
  finishedAt?: number;
  note?: string;
}

/** 群聊单条消息（支持用户消息、机器人消息与系统通知）。 */
export interface TeamMessage {
  id: string;
  groupId: string;
  senderKind: "user" | "bot" | "system";
  senderBotId?: string;
  content: string;
  mentions: TeamMentionRef[];
  attachments?: MessageAttachmentInfo[];
  replyToMessageId?: string;
  runCardId?: string;
  mode?: TeamChatMode;
  /** 机器人回复仍在流式生成中。 */
  streaming?: boolean;
  createdAt: number;
}

/** 团队群聊实体。 */
export interface TeamGroup {
  id: string;
  name: string;
  description: string;
  announcement: string;
  /** 自定义群头像图片 Data URL；空值表示使用默认成员头像堆叠。 */
  avatar?: string;
  memberBotIds: string[];
  coordinatorBotId: string;
  /** 私聊只允许这个机器人参与，创建后不可变更。 */
  directBotId?: string;
  mode: TeamChatMode;
  maxAutoRounds: number;
  execution: TeamExecutionConfig;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 后端持有的团队模式全量状态。 */
export interface TeamStateSnapshot {
  bots: TeamBot[];
  groups: TeamGroup[];
  messages: TeamMessage[];
  runs: TeamRunCard[];
  presence: Record<string, Record<string, TeamBotPresence>>;
}

/** 本次发送沿用的全局运行偏好（前端当前选择的模型、权限与项目）。 */
export interface TeamRunDefaults {
  model?: string;
  permissionMode?: "ask" | "auto" | "full";
  workspaceId?: string;
}

/** confirm_plan：确认规划模式生成的计划并开始执行。 */
export type TeamRunAction = "pause" | "resume" | "cancel" | "confirm_plan";

export type TeamCommand =
  | { type: "team.state.get"; requestId: string }
  /** 仅在后端团队表为空时导入旧版本地数据，避免覆盖已有记录。 */
  | { type: "team.state.import"; requestId: string; state: Omit<TeamStateSnapshot, "presence"> }
  | { type: "team.bot.save"; requestId: string; bot: TeamBot }
  | { type: "team.bot.delete"; requestId: string; botId: string }
  | { type: "team.group.create"; requestId: string; group: TeamGroup }
  | { type: "team.group.update"; requestId: string; groupId: string; patch: Partial<Omit<TeamGroup, "id" | "createdAt" | "directBotId">> }
  | { type: "team.group.delete"; requestId: string; groupId: string }
  | { type: "team.group.clear"; requestId: string; groupId: string }
  | { type: "team.message.send"; requestId: string; groupId: string; messageId: string; content: string; mentions: TeamMentionRef[]; attachments?: MessageAttachmentInfo[]; replyToMessageId?: string; mode?: TeamChatMode; defaults?: TeamRunDefaults }
  | { type: "team.run.action"; requestId: string; runId: string; action: TeamRunAction };

export type TeamEvent =
  | { type: "team.state"; requestId?: string; state: TeamStateSnapshot }
  | { type: "team.message.append"; message: TeamMessage }
  | { type: "team.message.delta"; groupId: string; messageId: string; delta: string }
  | { type: "team.run.upsert"; run: TeamRunCard }
  | { type: "team.bot.presence"; groupId: string; botId: string; presence: TeamBotPresence };

const request = { requestId: z.string().min(1), locale: z.enum(["en", "zh-CN"]).optional() };
const id = z.string().min(1).max(200);
const text = (max: number) => z.string().max(max);
const timestamp = z.number().int().nonnegative();
const mode = z.enum(["execute", "plan"]);
const strategy = z.enum(["smart", "local-only", "servers-preferred"]);

const CUSTOM_AVATAR_URL = /^data:image\/(?:webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/;
const avatar = z.string().refine(
  (value) => value.length <= 64 || (value.length <= 160_000 && CUSTOM_AVATAR_URL.test(value)),
  "Invalid avatar value",
);

const bot = z.object({
  id, name: z.string().trim().min(1).max(120), roleTitle: text(120), description: text(4_000),
  systemPrompt: text(32_000), logo: z.string().min(1).max(64), modelId: text(512),
  thinking: z.enum(["none", "minimal", "low", "medium", "high", "xhigh", "max"]).optional(), avatar: avatar.optional(),
  capabilities: z.array(text(64)).max(32), source: z.enum(["preset", "subagent", "custom"]),
  presetKey: text(64).optional(), linkedSubagentId: id.optional(), createdAt: timestamp, updatedAt: timestamp,
});
const execution = z.object({
  allowLocal: z.boolean(), serverIds: z.array(id).max(64), strategy, workspaceId: id.optional(),
});
const groupFields = {
  name: z.string().trim().min(1).max(120), description: text(4_000), announcement: text(16_000),
  avatar: avatar.optional(),
  memberBotIds: z.array(id).max(64), coordinatorBotId: text(200), mode,
  maxAutoRounds: z.number().int().min(1).max(50), execution, pinned: z.boolean().optional(), updatedAt: timestamp,
};
const group = z.object({ id, createdAt: timestamp, directBotId: id.optional(), ...groupFields });
const mention = z.object({ kind: z.enum(["all", "bot"]), targetId: id, label: text(120) });
const stepTarget = z.object({ kind: z.enum(["local", "server"]), id: id.optional(), label: text(200).optional() });
const step = z.object({
  id, kind: z.enum(["plan", "work", "verify", "respond", "summary"]).optional(), title: text(500), botId: text(200),
  status: z.enum(["pending", "running", "completed", "failed", "paused", "awaiting"]),
  targetKind: z.enum(["local", "server", "auto"]), targetId: id.optional(), targetLabel: text(200).optional(),
  targets: z.array(stepTarget).max(64).optional(), instruction: text(32_000).optional(), summary: text(4_000).optional(),
  activity: z.array(z.object({ id: text(512).optional(), tool: text(200), detail: text(120).optional(), outcome: z.enum(["running", "done", "failed", "blocked"]) })).max(12).optional(),
  messageId: id.optional(),
  startedAt: timestamp.optional(), finishedAt: timestamp.optional(),
});
const run = z.object({
  id, groupId: id, triggerMessageId: id, title: text(500), coordinatorBotId: text(200),
  status: z.enum(["queued", "planning", "running", "paused", "completed", "failed", "cancelled", "awaiting_runtime", "awaiting_confirmation"]),
  mode, strategy, targetServerIds: z.array(id).max(64), allowLocal: z.boolean(), steps: z.array(step).max(200),
  startedAt: timestamp, updatedAt: timestamp, finishedAt: timestamp.optional(), note: text(4_000).optional(),
});
const message = z.object({
  id, groupId: id, senderKind: z.enum(["user", "bot", "system"]), senderBotId: id.optional(),
  content: text(200_000), mentions: z.array(mention).max(64), attachments: z.array(messageAttachmentSchema).optional(),
  replyToMessageId: id.optional(),
  runCardId: id.optional(), mode: mode.optional(), createdAt: timestamp,
});

export const teamCommandSchemas = {
  "team.state.get": z.object({ type: z.literal("team.state.get"), ...request }),
  "team.state.import": z.object({
    type: z.literal("team.state.import"), ...request,
    state: z.object({ bots: z.array(bot).max(500), groups: z.array(group).max(500), messages: z.array(message).max(50_000), runs: z.array(run).max(10_000) }),
  }),
  "team.bot.save": z.object({ type: z.literal("team.bot.save"), ...request, bot }),
  "team.bot.delete": z.object({ type: z.literal("team.bot.delete"), ...request, botId: id }),
  "team.group.create": z.object({ type: z.literal("team.group.create"), ...request, group }),
  "team.group.update": z.object({ type: z.literal("team.group.update"), ...request, groupId: id, patch: z.object(groupFields).partial() }),
  "team.group.delete": z.object({ type: z.literal("team.group.delete"), ...request, groupId: id }),
  "team.group.clear": z.object({ type: z.literal("team.group.clear"), ...request, groupId: id }),
  "team.message.send": z.object({
    type: z.literal("team.message.send"), ...request, groupId: id, messageId: id,
    content: z.string().max(100_000), mentions: z.array(mention).max(64),
    attachments: z.array(messageAttachmentSchema).optional(),
    replyToMessageId: id.optional(), mode: mode.optional(),
    defaults: z.object({ model: text(512).optional(), permissionMode: z.enum(["ask", "auto", "full"]).optional(), workspaceId: id.optional() }).optional(),
  }).refine(
    (cmd) => (cmd.content.trim().length > 0 || (cmd.attachments?.length ?? 0) > 0) && nonMediaAttachmentBytes(cmd.attachments) <= 140_000_000,
    "Message content or attachments required",
  ),
  "team.run.action": z.object({ type: z.literal("team.run.action"), ...request, runId: id, action: z.enum(["pause", "resume", "cancel", "confirm_plan"]) }),
};

/** 规范化执行环境配置：未绑定服务器时保证本机启用且策略不会悬空。前后端共用同一规则。 */
export function normalizeTeamExecution(config: TeamExecutionConfig): TeamExecutionConfig {
  const serverIds = [...new Set(config.serverIds.filter(Boolean))];
  if (serverIds.length === 0) {
    return {
      ...config,
      serverIds: [],
      allowLocal: true,
      strategy: config.strategy === "servers-preferred" ? "smart" : config.strategy,
    };
  }
  return { ...config, serverIds, allowLocal: config.strategy === "local-only" ? true : config.allowLocal };
}
