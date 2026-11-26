import type { RuntimeCommand, TeamCommand, TeamEvent, TeamExecutionStrategy } from "@qone/protocol";

/** 团队模式领域模型统一来自共享协议，前后端只有一份类型定义。 */
export type {
  TeamBot,
  TeamBotPresence,
  TeamBotSource,
  TeamChatMode,
  TeamExecutionConfig,
  TeamExecutionStrategy,
  TeamMentionRef,
  TeamMessage,
  TeamRunAction,
  TeamRunCard,
  TeamRunStep,
  TeamStateSnapshot,
  TeamStepApproval,
  TeamStepTarget,
  TeamGroup,
} from "@qone/protocol";

/** 群聊模板定义（纯前端配置数据，创建群时按需实例化）。 */
export interface TeamGroupTemplate {
  id: string;
  nameKey: string;
  descriptionKey: string;
  botPresetKeys: string[];
  coordinatorPresetKey: string;
  defaultStrategy: TeamExecutionStrategy;
}

/** 后端编排引擎推送给前端的团队事件。 */
export type TeamRuntimeEvent = TeamEvent;

/** 不含 requestId 的团队命令，由传输层补齐。 */
export type TeamCommandInput<C = TeamCommand> = C extends unknown ? Omit<C, "requestId"> : never;

/** 团队命令的传输适配器：生产环境基于运行时连接发送，测试可替换为内存实现。 */
export interface TeamTransport {
  send: (command: TeamCommandInput | TeamApprovalCommandInput) => Promise<boolean> | boolean;
}

/** 成员工具审批复用运行时统一的审批命令。 */
export type TeamApprovalCommandInput = TeamCommandInput<Extract<RuntimeCommand, { type: "tool.approve" | "tool.reject" }>>;
