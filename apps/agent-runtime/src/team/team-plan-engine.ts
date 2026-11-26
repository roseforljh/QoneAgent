import { Type } from "typebox";
import { z } from "zod";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TeamBot } from "@qone/protocol";
import type { TeamStepRecord } from "./team-records.js";

export const TEAM_PLAN_TOOL = "team_plan";

/** 统筹提交的计划步骤。 */
export interface TeamPlanStep {
  id: string;
  botId: string;
  title: string;
  task: string;
  dependsOn: string[];
  /** 验收步骤：核对的工作步骤 ID，负责人必须不是该成果的作者。 */
  verifies?: string;
}

export interface TeamPlanContext {
  members: readonly TeamBot[];
  coordinatorBotId: string;
  /** 本次运行剩余可用的自动协作轮次。 */
  remainingRounds: number;
}

export type TeamPlanResult = { ok: true; steps: TeamPlanStep[] } | { ok: false; issue: string };

const stepSchema = z.object({
  id: z.string().trim().regex(/^[A-Za-z0-9_-]{1,40}$/),
  botId: z.string().trim().min(1).max(200),
  title: z.string().trim().min(1).max(200),
  task: z.string().trim().min(1).max(8_000),
  dependsOn: z.array(z.string()).max(20).nullish().transform((list) =>
    (list ?? []).map((item) => item.trim()).filter(Boolean),
  ),
  verifies: z.string().nullish().transform((value) => {
    const trimmed = value?.trim();
    return trimmed ? trimmed : undefined;
  }),
});
const planSchema = z.object({ steps: z.array(stepSchema).min(1).max(50) });

/** 优先精确匹配成员 ID；若模型传入成员名（含 @ 前缀）且群内唯一，则自动解析为对应 ID。 */
function resolveMemberBotId(raw: string, members: readonly TeamBot[]): string | undefined {
  if (members.some((bot) => bot.id === raw)) return raw;
  const normalized = raw.replace(/^@+/, "").trim();
  if (!normalized) return undefined;
  const matched = members.filter((bot) => bot.name.trim() === normalized);
  return matched.length === 1 ? matched[0]!.id : undefined;
}

/**
 * 程序校验统筹的计划，只返回第一个问题并说明怎么改，避免模型反复提交同样的结构。
 * 确定性修复：规范化空 verifies/null dependsOn、唯一成员名解析，以及验收步骤自动依赖核对步骤。
 */
export function validateTeamPlan(value: unknown, context: TeamPlanContext): TeamPlanResult {
  const parsed = planSchema.safeParse(value);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return { ok: false, issue: `Invalid plan at ${issue?.path.join(".") || "root"}: ${issue?.message ?? "schema mismatch"}. Expected {"steps":[{"id":"s1","botId":"<member id>","title":"...","task":"...","dependsOn":[]}]}.` };
  }
  const steps: TeamPlanStep[] = parsed.data.steps.map((step) => ({
    ...step,
    dependsOn: [...new Set(step.dependsOn)],
    ...(step.verifies !== undefined ? { verifies: step.verifies } : {}),
  }));
  if (steps.length > context.remainingRounds) {
    return { ok: false, issue: `The plan has ${steps.length} steps but only ${context.remainingRounds} automatic collaboration round(s) remain. Merge steps so there are at most ${context.remainingRounds}.` };
  }
  const delegates = context.members.filter((bot) => bot.id !== context.coordinatorBotId);
  const assignable = delegates.length ? delegates : context.members;
  const assignableList = assignable.map((bot) => `${bot.id} (${bot.name})`).join(", ");
  const ids = new Set<string>();
  for (const [index, step] of steps.entries()) {
    if (ids.has(step.id)) return { ok: false, issue: `Step ${index + 1} reuses id "${step.id}". Every step id must be unique.` };
    ids.add(step.id);
    const resolvedId = resolveMemberBotId(step.botId, context.members);
    if (!resolvedId) return { ok: false, issue: `Step ${index + 1} botId "${step.botId}" is not a member of this group. Use one of: ${assignableList}.` };
    step.botId = resolvedId;
    if (delegates.length && step.botId === context.coordinatorBotId) {
      return { ok: false, issue: `Step ${index + 1} is assigned to the coordinator. Assign work to members by expertise (${assignableList}); the coordinator only plans and summarizes.` };
    }
  }
  const byId = new Map(steps.map((step) => [step.id, step]));
  for (const [index, step] of steps.entries()) {
    const missing = step.dependsOn.find((dependency) => !byId.has(dependency) || dependency === step.id);
    if (missing) return { ok: false, issue: `Step ${index + 1} depends on "${missing}", which is not another step of this plan.` };
    if (step.verifies === undefined) continue;
    const target = byId.get(step.verifies);
    if (!target || target.id === step.id) return { ok: false, issue: `Step ${index + 1} verifies "${step.verifies}", which is not another step of this plan.` };
    if (target.verifies !== undefined) return { ok: false, issue: `Step ${index + 1} verifies a verification step. Verify the work step instead.` };
    if (target.botId === step.botId) return { ok: false, issue: `Step ${index + 1} verifies work by the same member. An independent member must do the check.` };
    if (!step.dependsOn.includes(target.id)) step.dependsOn.push(target.id);
  }
  return hasCycle(steps) ? { ok: false, issue: "The dependencies form a cycle. Remove one dependency so steps can run in order." } : { ok: true, steps };
}

function hasCycle(steps: readonly Pick<TeamPlanStep, "id" | "dependsOn">[]): boolean {
  const state = new Map<string, "visiting" | "done">();
  const byId = new Map(steps.map((step) => [step.id, step]));
  const visit = (id: string): boolean => {
    if (state.get(id) === "done") return false;
    if (state.get(id) === "visiting") return true;
    state.set(id, "visiting");
    const cyclic = (byId.get(id)?.dependsOn ?? []).some(visit);
    state.set(id, "done");
    return cyclic;
  };
  return steps.some((step) => visit(step.id));
}

/** 依赖全部完成、自身待执行的步骤。 */
export function readySteps(steps: readonly TeamStepRecord[]): TeamStepRecord[] {
  const status = new Map(steps.map((step) => [step.id, step.status]));
  return steps.filter((step) => step.status === "pending" && step.dependsOn.every((id) => status.get(id) === "completed"));
}

/** 依赖已失败而永远无法执行的待执行步骤。 */
export function blockedSteps(steps: readonly TeamStepRecord[]): TeamStepRecord[] {
  const failed = new Set(steps.filter((step) => step.status === "failed").map((step) => step.id));
  const blocked = new Set<string>();
  let changed = true;
  while (changed) {
    changed = false;
    for (const step of steps) {
      if (step.status !== "pending" || blocked.has(step.id)) continue;
      if (step.dependsOn.some((id) => failed.has(id) || blocked.has(id))) { blocked.add(step.id); changed = true; }
    }
  }
  return steps.filter((step) => blocked.has(step.id));
}

/** 统筹专用的计划提交工具；非规划回合保留同名同 Schema 占位以维持跨步骤工具前缀稳定，校验失败时把问题交回模型修改。 */
export function createTeamPlanTool(context?: TeamPlanContext, onAccepted?: (steps: TeamPlanStep[]) => void): ToolDefinition {
  return {
    name: TEAM_PLAN_TOOL,
    label: "Submit team plan",
    description: "Split the user's request into steps for group members and submit them. Each step names one member (botId), a short title, a self-contained task, the step ids it depends on, and for an independent check the id of the work step it verifies. Steps without dependencies run in parallel. Only call this when you are the coordinator in a planning turn and the work needs members; answer simple questions directly instead.",
    parameters: Type.Object({
      steps: Type.Array(Type.Object({
        id: Type.String({ description: "Short unique id such as s1" }),
        botId: Type.String({ description: "Member id from the group roster" }),
        title: Type.String({ description: "Short step title in the user's language" }),
        task: Type.String({ description: "Self-contained instructions for the member" }),
        dependsOn: Type.Optional(Type.Union([Type.Array(Type.String()), Type.Null()])),
        verifies: Type.Optional(Type.Union([
          Type.String({ description: "Work step id this step independently checks; omit or pass null for normal work steps" }),
          Type.Null(),
        ])),
      }), { minItems: 1, maxItems: 50 }),
    }),
    executionMode: "sequential",
    execute: async (_id, args) => {
      if (!context || !onAccepted) throw new Error("team_plan is only available during the coordinator's planning turn.");
      const result = validateTeamPlan(args, context);
      if (!result.ok) throw new Error(result.issue);
      onAccepted(result.steps);
      return {
        content: [{ type: "text", text: `Plan accepted with ${result.steps.length} step(s). The program dispatches them to the members; do not do their work yourself. Reply with one or two sentences telling the user how the work is split.` }],
        details: {},
      };
    },
  };
}
