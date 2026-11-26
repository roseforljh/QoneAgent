import { Type } from "typebox";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { TeamBot, TeamToolActivity } from "@qone/protocol";
import { runtimeText } from "../runtime-localization.js";
import type { TeamRunRecord, TeamStepRecord, TeamVerdict } from "./team-records.js";

export const TEAM_VERDICT_TOOL = "team_verdict";
/** 同一成果最多自动打回修复的次数，超过后交由统筹汇总说明。 */
export const MAX_REPAIRS = 2;
const HANDOFF_CHARS = 6_000;
const ACTIVITY_LIMIT = 12;

/** 验收专用工具：非验收回合保留同名同 Schema 占位以维持跨步骤工具前缀稳定。 */
export function createVerdictTool(onVerdict?: (verdict: TeamVerdict) => void): ToolDefinition {
  return {
    name: TEAM_VERDICT_TOOL,
    label: "Submit verification verdict",
    description: "Report the result of your independent check. Only call this during an independent verification turn. Use fail with concrete, actionable failures when the work does not meet the task; the program sends it back to the author for a fix and asks you to check again.",
    parameters: Type.Object({
      verdict: Type.Union([Type.Literal("pass"), Type.Literal("fail")]),
      failures: Type.Optional(Type.Union([
        Type.Array(Type.String({ maxLength: 300 }), { maxItems: 10, description: "What must be fixed; empty when passing" }),
        Type.Null(),
      ])),
    }),
    executionMode: "sequential",
    execute: async (_id, args) => {
      if (!onVerdict) throw new Error("team_verdict is only available during an independent verification turn.");
      const value = args as { verdict: "pass" | "fail"; failures?: string[] | null };
      const failures = (value.failures ?? []).map((item) => item.trim()).filter(Boolean).slice(0, 10);
      if (value.verdict === "fail" && !failures.length) throw new Error("A failing verdict must list at least one concrete failure.");
      onVerdict({ verdict: value.verdict, failures });
      return { content: [{ type: "text", text: `Verdict recorded: ${value.verdict}.` }], details: {} };
    },
  };
}

/**
 * 验收不通过时生成「原作者修复 + 同一验收人复验」两步，受打回次数与剩余轮次双重限制。
 * 返回 undefined 表示不再自动修复。
 */
export function repairSteps(record: TeamRunRecord, check: TeamStepRecord, botsById: ReadonlyMap<string, TeamBot>): TeamStepRecord[] | undefined {
  const work = record.steps.find((step) => step.id === check.verifies);
  if (!work || check.verdict?.verdict !== "fail") return undefined;
  const root = work.repairOf ?? work.id;
  const repairs = record.steps.filter((step) => step.kind === "work" && step.repairOf === root).length;
  const remaining = record.mode === "plan" && !record.confirmed ? 0 : record.maxAutoRounds - record.roundsUsed - pendingRounds(record);
  if (repairs >= MAX_REPAIRS || remaining < 2) return undefined;
  const suffix = `r${repairs + 1}`;
  const fixId = `${root}-fix-${suffix}`;
  const failures = check.verdict.failures.map((item) => `- ${item}`).join("\n");
  const author = botsById.get(work.botId)?.name ?? work.botId;
  const verifier = botsById.get(check.botId)?.name ?? check.botId;
  const base = { status: "pending" as const, targetKind: work.targetKind, attempts: 0 };
  return [
    {
      ...base, id: fixId, kind: "work", botId: work.botId, repairOf: root, dependsOn: [],
      title: `${work.title} · ${runtimeText("team.step.fix")}`,
      instruction: `${work.instruction ?? work.title}\n\n${verifier} checked your previous result and it did not pass. Fix these problems, then report what changed:\n${failures}`,
    },
    {
      ...base, id: `${check.repairOf ?? check.id}-recheck-${suffix}`, kind: "verify", botId: check.botId, repairOf: check.repairOf ?? check.id,
      verifies: fixId, dependsOn: [fixId],
      title: `${check.title} · ${runtimeText("team.step.recheck")}`,
      instruction: `${check.instruction ?? check.title}\n\nThis is a recheck after ${author} fixed the failures you reported:\n${failures}`,
    },
  ];
}

/** 已排入但尚未计入轮次的成员步骤。 */
export const pendingRounds = (record: TeamRunRecord) =>
  record.steps.filter((step) => step.kind !== "plan" && step.kind !== "summary" && !step.counted && step.status !== "completed" && step.status !== "failed").length;

/** 记录一次工具调用的摘要，只保留命令或路径，不保存输出。 */
export function activityOf(toolName: string, args: unknown): TeamToolActivity {
  const value = args && typeof args === "object" ? args as Record<string, unknown> : {};
  const raw = [value.command, value.path, value.file, value.remote_path, value.code].find((item) => typeof item === "string") as string | undefined;
  const detail = raw?.replace(/\s+/g, " ").trim().slice(0, 120);
  return { tool: toolName, ...(detail ? { detail } : {}), outcome: "running" };
}

export function appendActivity(list: readonly TeamToolActivity[] | undefined, entry: TeamToolActivity): TeamToolActivity[] {
  return [...(list ?? []), entry].slice(-ACTIVITY_LIMIT);
}

/** 断点续跑摘要：来自被打断回合的真实工具记录，不调用模型。 */
export function resumeSummary(step: TeamStepRecord): string {
  const lines = ["This step was interrupted by a pause and is continuing now. Files and remote state may have changed during the pause (including by the user): re-read what you rely on before editing, and do not redo finished parts."];
  const activity = step.activity ?? [];
  if (activity.length) {
    lines.push("What the interrupted run did (oldest first, from Qone's records):");
    for (const item of activity) lines.push(`- ${item.tool}${item.detail ? `: ${item.detail}` : ""} → ${item.outcome === "running" ? "stopped by the pause" : item.outcome}`);
  }
  if (step.output?.trim()) lines.push(`Its last reply before the pause:\n${clip(step.output, 2_000)}`);
  return lines.join("\n");
}

/** 交接上下文：依赖步骤的成果按依赖顺序传给下一位成员。 */
export function handoffContext(record: TeamRunRecord, step: TeamStepRecord, botsById: ReadonlyMap<string, TeamBot>): string {
  const sources = step.dependsOn.map((id) => record.steps.find((item) => item.id === id)).filter((item): item is TeamStepRecord => Boolean(item?.output));
  if (!sources.length) return "";
  const room = Math.max(800, Math.floor(HANDOFF_CHARS / sources.length));
  return sources.map((source) => {
    const author = botsById.get(source.botId)?.name ?? source.botId;
    const verdict = source.verdict ? ` (verdict: ${source.verdict.verdict}${source.verdict.failures.length ? `; ${source.verdict.failures.join("; ")}` : ""})` : "";
    return `<handoff from="${escapeAttr(author)}" step="${source.id}" title="${escapeAttr(source.title)}">\n${clip(source.output ?? "", room)}${verdict}\n</handoff>`;
  }).join("\n");
}

export function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n…(truncated)` : text;
}

export const escapeAttr = (value: string) => value.replace(/[<>"&\r\n]+/g, " ");
