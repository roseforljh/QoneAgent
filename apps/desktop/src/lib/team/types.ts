import type { SubagentLogoId } from "@qone/protocol";

/** 团队执行路由策略：默认允许在“本机”与已绑定服务器间按任务意图智能调度。 */
export type TeamExecutionStrategy = "smart" | "local-only" | "servers-preferred";

/** 群聊协作模式：执行模式可直接调度工具，规划模式仅产出方案待确认。 */
export type TeamChatMode = "execute" | "plan";

/** 单个机器人当前在群内的可视化状态。 */
export type TeamBotPresence = "idle" | "thinking" | "working" | "waiting";

/** 机器人来源：内置预设、从设置同步的子代理、或用户新建的自定义机器人。 */
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
  capabilities: string[];
  source: TeamBotSource;
  /** 仅当 source === "preset" 时用于绑定模板预设键。 */
  presetKey?: string;
  /** 仅当 source === "subagent" 时关联设置页中的子代理配置 ID。 */
  linkedSubagentId?: string;
  createdAt: number;
  updatedAt: number;
}

/** 群聊绑定的执行环境配置：本机始终可用，服务器可按需绑定 0~N 台。 */
export interface TeamExecutionConfig {
  /** 本机环境开关；未绑定服务器时自动保持为 true。 */
  allowLocal: boolean;
  /** 已绑定的远程 SSH 服务器 ID 列表（来自 useServerStore）。 */
  serverIds: string[];
  /** 任务路由策略。 */
  strategy: TeamExecutionStrategy;
  /** 可选绑定的本地项目工作区 ID（来自 useStore.workspaces）。 */
  workspaceId?: string;
}

/** 单条消息中解析出的 @ 提及信息。 */
export interface TeamMentionRef {
  kind: "all" | "bot";
  /** kind === "all" 时为 "all"，否则为对应机器人 ID。 */
  targetId: string;
  label: string;
}

/** Agent 运行状态卡的单步执行项（对应 Marked Agent Run Status Card 步骤列表）。 */
export interface TeamRunStep {
  id: string;
  title: string;
  botId: string;
  status: "pending" | "running" | "completed" | "failed" | "paused" | "awaiting";
  /** 该步骤解析后的执行环境标签（如本机或具体服务器名称）。 */
  targetKind: "local" | "server" | "auto";
  targetId?: string;
  targetLabel?: string;
  summary?: string;
  startedAt?: number;
  finishedAt?: number;
}

/** 嵌入群聊消息流与任务抽屉的通用运行状态卡数据结构。 */
export interface TeamRunCard {
  id: string;
  groupId: string;
  triggerMessageId: string;
  title: string;
  coordinatorBotId: string;
  status: "queued" | "planning" | "running" | "paused" | "completed" | "failed" | "cancelled" | "awaiting_runtime";
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
  replyToMessageId?: string;
  runCardId?: string;
  mode?: TeamChatMode;
  createdAt: number;
}

/** 团队群聊实体。 */
export interface TeamGroup {
  id: string;
  name: string;
  description: string;
  announcement: string;
  memberBotIds: string[];
  coordinatorBotId: string;
  mode: TeamChatMode;
  maxAutoRounds: number;
  execution: TeamExecutionConfig;
  pinned?: boolean;
  createdAt: number;
  updatedAt: number;
}

/** 群聊模板定义（纯配置数据，创建群时按需实例化）。 */
export interface TeamGroupTemplate {
  id: string;
  nameKey: string;
  descriptionKey: string;
  botPresetKeys: string[];
  coordinatorPresetKey: string;
  defaultStrategy: TeamExecutionStrategy;
}

/** 供后续接入真实后端多 Agent 编排引擎使用的通用事件协议。 */
export type TeamRuntimeEvent =
  | { type: "team.message.append"; message: TeamMessage }
  | { type: "team.run.upsert"; run: TeamRunCard }
  | { type: "team.bot.presence"; groupId: string; botId: string; presence: TeamBotPresence };

/** 供后续接入后端运行时实现的通用传输适配器接口。 */
export interface TeamTransport {
  sendGroupMessage?: (input: {
    group: TeamGroup;
    message: TeamMessage;
    run: TeamRunCard;
    bots: TeamBot[];
  }) => Promise<void> | void;
  updateRunStatus?: (runId: string, action: "pause" | "resume" | "cancel") => Promise<void> | void;
}
