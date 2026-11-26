import type { MessageAttachmentInfo, RuntimeLocale, TeamChatMode, TeamRunCard, TeamRunDefaults, TeamRunStep, TeamStepKind } from "@qone/protocol";

export type { TeamStepKind };

export interface TeamVerdict {
  verdict: "pass" | "fail";
  failures: string[];
}

/** 持久化的步骤记录：在协议卡片字段之外携带编排所需的内部状态。 */
export interface TeamStepRecord extends TeamRunStep {
  kind: TeamStepKind;
  dependsOn: string[];
  /** 验收步骤所核对的工作步骤 ID。 */
  verifies?: string;
  /** 自动修复链路的源步骤 ID，用于限制同一成果的打回次数。 */
  repairOf?: string;
  /** 规划模式下成员的只读方案，确认后作为执行依据。 */
  proposal?: string;
  output?: string;
  verdict?: TeamVerdict;
  /** 已执行次数（含被暂停打断的那次）。 */
  attempts: number;
  /** 下一次执行是暂停后的续跑。 */
  resumed?: boolean;
  /** 已计入自动协作轮次。 */
  counted?: boolean;
  /** 本步骤对应的群消息 ID。 */
  messageId?: string;
}

export type TeamRunPhase = "planning" | "proposing" | "awaiting" | "executing" | "summarizing" | "done";

/** 持久化的运行记录：路由结果、阶段与轮次预算都存于此，重启后可从断点恢复。 */
export interface TeamRunRecord extends Omit<TeamRunCard, "steps"> {
  steps: TeamStepRecord[];
  route: "coordinator" | "mentions" | "all";
  phase: TeamRunPhase;
  prompt: string;
  /** 触发消息携带的图片/文件/文件夹附件，透传给各成员回合的模型与工具上下文。 */
  attachments?: MessageAttachmentInfo[];
  /** 规划模式的计划已由用户确认。 */
  confirmed: boolean;
  roundsUsed: number;
  /** 创建时群配置的自动协作轮次上限。 */
  maxAutoRounds: number;
  defaults: TeamRunDefaults;
  locale?: RuntimeLocale;
  /** 统筹在规划回合直接给出的答复（无需分派时即为最终结论）。 */
  directReply?: string;
}

const STEP_INTERNAL = ["dependsOn", "verifies", "repairOf", "proposal", "output", "verdict", "attempts", "resumed", "counted"] as const;

/** 推送给前端的卡片只保留协议字段。 */
export function toRunCard(record: TeamRunRecord): TeamRunCard {
  const { route: _route, phase: _phase, prompt: _prompt, attachments: _attachments, confirmed: _confirmed, roundsUsed: _rounds, maxAutoRounds: _max, defaults: _defaults, locale: _locale, directReply: _reply, steps, ...card } = record;
  return {
    ...card,
    steps: steps.map((step) => {
      const visible: Record<string, unknown> = { ...step };
      for (const key of STEP_INTERNAL) delete visible[key];
      return visible as unknown as TeamRunStep;
    }),
  };
}

export const isLiveStatus = (status: TeamRunCard["status"]) => status === "queued" || status === "planning" || status === "running";

/** 执行时是否放开写操作：执行模式，或规划模式的计划已被确认。 */
export const canWrite = (record: Pick<TeamRunRecord, "mode" | "confirmed">, mode: TeamChatMode = record.mode) => mode === "execute" || record.confirmed;

/** 单行摘要，供卡片步骤行展示。 */
export function oneLine(text: string, max = 160): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
