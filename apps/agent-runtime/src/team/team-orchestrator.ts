import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { MessageAttachmentInfo, RunPermissionMode, TeamThinkingLevel, TeamBot, TeamBotPresence, TeamGroup, TeamMessage, TeamStepApproval, TeamStepTarget } from "@qone/protocol";
import { runtimeText, withRuntimeLocale } from "../runtime-localization.js";
import { SubagentScheduler } from "../subagent-scheduler.js";
import { expectedTarget, withObservedTarget, type TeamExecutionScope } from "./team-environment.js";
import { activityOf, appendActivity, createVerdictTool, repairSteps } from "./team-handoff.js";
import { blockedSteps, createTeamPlanTool, readySteps, type TeamPlanStep } from "./team-plan-engine.js";
import { planPrompt, respondPrompt, stepPrompt, summaryPrompt, type TeamPromptContext } from "./team-prompts.js";
import { canWrite, isLiveStatus, oneLine, type TeamRunRecord, type TeamStepRecord, type TeamVerdict } from "./team-records.js";
import { summaryStep } from "./team-router.js";

/** 一次成员回合的实时回调；所有环境与审批信息都来自运行时事件。 */
export interface TeamTurnObserver {
  delta(text: string): void;
  toolStarted(toolName: string, args: unknown, callId?: string): void;
  toolFinished(toolName: string, outcome: "done" | "failed" | "blocked", callId?: string, detail?: string): void;
  target(target: TeamStepTarget): void;
  approval(approval: TeamStepApproval | undefined): void;
}

export interface TeamTurnRequest {
  sessionId: string;
  /** 群级稳定缓存键，用于同群跨步骤复用 provider 前缀缓存与服务器状态稳定化。 */
  cacheKey?: string;
  bot: TeamBot;
  prompt: string;
  attachments?: MessageAttachmentInfo[];
  model?: string;
  /** 仅当成员用自己指定的模型时才带上它的推理强度。 */
  thinking?: TeamThinkingLevel;
  permissionMode: RunPermissionMode;
  scope: TeamExecutionScope;
  tools: ToolDefinition[];
}

/** 执行一次成员回合并返回其完整回复文本；signal 中止时尽快结束。 */
export interface TeamTurnRunner {
  run(request: TeamTurnRequest, observer: TeamTurnObserver, signal: AbortSignal): Promise<string>;
}

export interface TeamOrchestratorHost {
  runner: TeamTurnRunner;
  group(groupId: string): TeamGroup | undefined;
  bots(): readonly TeamBot[];
  scope(group: TeamGroup, record: TeamRunRecord, readOnly: boolean, planningDelegation?: boolean): TeamExecutionScope;
  model(bot: TeamBot, record: TeamRunRecord): string | undefined;
  /** 触发消息之前的群聊记录。 */
  history(record: TeamRunRecord): TeamMessage[];
  saveRun(record: TeamRunRecord): void;
  message(message: TeamMessage): void;
  delta(groupId: string, messageId: string, delta: string): void;
  presence(groupId: string, botId: string, presence: TeamBotPresence): void;
  concurrency(): number;
}

class TeamAbort extends Error {}

interface ActiveRun { controller: AbortController; record: TeamRunRecord; done: Promise<void> }

const MEMBER_KINDS = new Set(["work", "verify", "respond"]);
const isMember = (step: TeamStepRecord) => MEMBER_KINDS.has(step.kind);

/**
 * 群聊编排状态机：planning → (proposing) → (awaiting) → executing → summarizing → done。
 * 所有状态都写回运行记录，暂停、取消与重启后均可从记录中的阶段与步骤状态继续。
 */
export class TeamOrchestrator {
  private readonly active = new Map<string, ActiveRun>();
  private readonly scheduler: SubagentScheduler;
  private readonly busy = new Map<string, number>();

  constructor(private readonly host: TeamOrchestratorHost) {
    this.scheduler = new SubagentScheduler(() => host.concurrency());
  }

  isActive(runId: string) { return this.active.has(runId); }

  /** 正在运行的记录对象是唯一可信副本，外部读取时优先使用它。 */
  live(runId: string): TeamRunRecord | undefined { return this.active.get(runId)?.record; }

  start(record: TeamRunRecord) {
    this.host.saveRun(record);
    if (isLiveStatus(record.status)) void this.drive(record);
  }

  pause(record: TeamRunRecord): TeamRunRecord {
    const current = this.live(record.id) ?? record;
    if (!isLiveStatus(current.status)) return current;
    this.interrupt(current, "paused");
    return current;
  }

  cancel(record: TeamRunRecord): TeamRunRecord {
    const current = this.live(record.id) ?? record;
    if (["completed", "failed", "cancelled"].includes(current.status)) return current;
    this.interrupt(current, "cancelled");
    current.finishedAt = Date.now();
    this.host.saveRun(current);
    return current;
  }

  /** 继续：被暂停打断的步骤带着续跑标记重新执行，已完成步骤保留。 */
  resume(record: TeamRunRecord): TeamRunRecord {
    if (record.status !== "paused") return record;
    for (const step of record.steps) if (step.status === "paused") Object.assign(step, { status: "pending", resumed: true });
    record.status = record.phase === "planning" ? "planning" : "running";
    record.note = undefined;
    this.touch(record);
    void this.drive(record);
    return record;
  }

  /** 确认计划：规划模式的计划卡转为执行。 */
  confirm(record: TeamRunRecord): TeamRunRecord {
    if (record.status !== "awaiting_confirmation") return record;
    record.confirmed = true;
    for (const step of record.steps) if (step.status === "awaiting") step.status = "pending";
    record.phase = "executing";
    record.status = "running";
    record.note = undefined;
    this.touch(record);
    void this.drive(record);
    return record;
  }

  /** 重启后：运行中的记录标为暂停，等待用户点继续。 */
  static recover(record: TeamRunRecord, note: string): TeamRunRecord {
    for (const step of record.steps) if (step.status === "running") Object.assign(step, { status: "paused", approval: undefined });
    return { ...record, status: "paused", note, updatedAt: Date.now() };
  }

  /** 删除或清空群聊前停止其全部运行。 */
  async stopGroup(groupId: string) {
    const runs = [...this.active.values()].filter((item) => item.record.groupId === groupId);
    for (const run of runs) this.interrupt(run.record, "cancelled");
    await Promise.allSettled(runs.map((run) => run.done));
  }

  private interrupt(record: TeamRunRecord, status: "paused" | "cancelled") {
    record.status = status;
    for (const step of record.steps) if (step.status === "running") Object.assign(step, { status: "paused", approval: undefined });
    this.active.get(record.id)?.controller.abort(new TeamAbort(status));
    this.touch(record);
  }

  private touch(record: TeamRunRecord) {
    record.updatedAt = Date.now();
    this.host.saveRun(record);
  }

  private async drive(record: TeamRunRecord) {
    const previous = this.active.get(record.id);
    if (previous) {
      if (!previous.controller.signal.aborted) return;
      await previous.done;
      if (this.active.has(record.id) || !isLiveStatus(record.status)) return;
    }
    const controller = new AbortController();
    const entry: ActiveRun = { controller, record, done: Promise.resolve() };
    this.active.set(record.id, entry);
    entry.done = withRuntimeLocale(record.locale, () => this.loop(record, controller.signal))
      .catch((error) => {
        if (controller.signal.aborted) return;
        record.status = "failed";
        record.note = oneLine(error instanceof Error ? error.message : String(error), 400);
        record.finishedAt = Date.now();
        this.touch(record);
      })
      .finally(() => { if (this.active.get(record.id) === entry) this.active.delete(record.id); });
    await entry.done;
  }

  private async loop(record: TeamRunRecord, signal: AbortSignal) {
    while (!signal.aborted) {
      if (record.phase === "planning") await this.planPhase(record, signal);
      else if (record.phase === "proposing") await this.proposePhase(record, signal);
      else if (record.phase === "executing") await this.executePhase(record, signal);
      else if (record.phase === "summarizing") await this.summaryPhase(record, signal);
      else if (record.phase === "awaiting") {
        record.status = "awaiting_confirmation";
        record.note = runtimeText("team.note.awaiting_confirmation");
        this.touch(record);
        return;
      } else {
        this.finish(record);
        return;
      }
    }
  }

  private finish(record: TeamRunRecord) {
    const failed = record.steps.some((step) => step.status === "failed");
    record.status = failed ? "failed" : "completed";
    record.finishedAt = Date.now();
    this.touch(record);
  }

  private needsConfirmation = (record: TeamRunRecord) => record.mode === "plan" && !record.confirmed;

  /** 统筹规划：直接答复或经 team_plan 提交经程序校验的计划。 */
  private async planPhase(record: TeamRunRecord, signal: AbortSignal) {
    const step = record.steps.find((item) => item.kind === "plan");
    if (!step || step.status === "completed") { record.phase = "executing"; return; }
    const group = this.requireGroup(record);
    const members = group.memberBotIds.map((id) => this.bot(id)).filter((bot): bot is TeamBot => Boolean(bot));
    const hasDelegates = members.some((bot) => bot.id !== step.botId);
    let accepted: TeamPlanStep[] | undefined;
    const remainingRounds = record.maxAutoRounds - record.roundsUsed;
    const tool = createTeamPlanTool({ members, coordinatorBotId: step.botId, remainingRounds }, (steps) => { accepted = steps; });
    const text = await this.turn(record, step, signal, true, { plan: tool }, (context) => planPrompt(context, remainingRounds), hasDelegates);
    if (text === undefined) {
      if (!signal.aborted) record.phase = "done";
      return;
    }
    if (!accepted) {
      record.directReply = text;
      record.phase = "done";
      return;
    }
    const scope = this.host.scope(group, record, false);
    const status = this.needsConfirmation(record) ? "awaiting" as const : "pending" as const;
    record.steps.push(...accepted.map((item): TeamStepRecord => ({
      id: item.id, kind: item.verifies ? "verify" : "work", botId: item.botId, title: item.title, instruction: item.task,
      dependsOn: item.dependsOn, ...(item.verifies ? { verifies: item.verifies } : {}), status, attempts: 0, ...expectedTarget(scope),
    })));
    const coordinator = this.bot(step.botId);
    if (coordinator) record.steps.push({ ...summaryStep(coordinator, accepted.map((item) => item.id), scope), status });
    record.phase = status === "awaiting" ? "awaiting" : "executing";
    this.touch(record);
  }

  /** 规划模式的 @ 路由：每位被唤醒成员先给出只读方案。 */
  private async proposePhase(record: TeamRunRecord, signal: AbortSignal) {
    const pending = record.steps.filter((step) => step.kind === "respond" && step.proposal === undefined && step.status !== "failed");
    await Promise.all(pending.map((step) => this.withPermit(step, signal, async () => {
      const text = await this.turn(record, step, signal, true, {}, (context) => respondPrompt(context, step, true));
      if (text === undefined) return;
      step.proposal = text;
      step.status = "awaiting";
      this.touch(record);
    })));
    if (signal.aborted) return;
    if (!record.steps.some((step) => step.kind === "respond" && step.status === "awaiting")) { record.phase = "done"; return; }
    for (const step of record.steps) if (step.status === "pending") step.status = "awaiting";
    record.phase = "awaiting";
  }

  /** 按依赖推进成员步骤：无依赖或依赖已完成的步骤并发执行，受全局并发上限约束。 */
  private async executePhase(record: TeamRunRecord, signal: AbortSignal) {
    const running = new Map<string, Promise<void>>();
    while (!signal.aborted) {
      for (const step of blockedSteps(record.steps.filter(isMember))) {
        Object.assign(step, { status: "failed", summary: runtimeText("team.step.blocked"), finishedAt: Date.now() });
        this.touch(record);
      }
      for (const step of readySteps(record.steps.filter(isMember))) {
        if (running.has(step.id)) continue;
        running.set(step.id, this.withPermit(step, signal, () => this.memberStep(record, step, signal)).finally(() => running.delete(step.id)));
      }
      if (!running.size) break;
      await Promise.race(running.values());
    }
    // 中止时等所有回合写完收尾状态，保证删除/清空群聊之后不会再有迟到的写入。
    await Promise.allSettled(running.values());
    if (signal.aborted) return;
    record.phase = record.steps.some((step) => step.kind === "summary" && step.status !== "completed") ? "summarizing" : "done";
  }

  private async memberStep(record: TeamRunRecord, step: TeamStepRecord, signal: AbortSignal) {
    if (!(record.route === "all" && step.kind === "respond") && !step.counted) { step.counted = true; record.roundsUsed++; }
    let verdict: TeamVerdict | undefined;
    const tools = step.kind === "verify" ? { verdict: createVerdictTool((value) => { verdict = value; }) } : {};
    const readOnly = !canWrite(record);
    const text = await this.turn(record, step, signal, readOnly, tools, (context) =>
      step.kind === "respond" ? respondPrompt(context, step, false) : stepPrompt(context, step));
    if (text === undefined || step.kind !== "verify" || step.status !== "completed") return;
    if (!verdict) { step.summary = runtimeText("team.step.no_verdict"); this.touch(record); return; }
    step.verdict = verdict;
    if (verdict.verdict === "fail") {
      const repairs = repairSteps(record, step, new Map(this.host.bots().map((bot) => [bot.id, bot])));
      if (repairs) {
        const summary = record.steps.find((item) => item.kind === "summary");
        if (summary) summary.dependsOn.push(...repairs.map((item) => item.id));
        record.steps.splice(summary ? record.steps.indexOf(summary) : record.steps.length, 0, ...repairs);
      } else {
        record.note = runtimeText("team.note.repair_exhausted");
      }
    }
    this.touch(record);
  }

  private async summaryPhase(record: TeamRunRecord, signal: AbortSignal) {
    const step = record.steps.find((item) => item.kind === "summary" && item.status !== "completed");
    if (!step) { record.phase = "done"; return; }
    if (step.status === "awaiting") step.status = "pending";
    const text = await this.turn(record, step, signal, true, {}, (context) => summaryPrompt(context, record.note));
    if (text !== undefined || !signal.aborted) record.phase = "done";
  }

  private async withPermit(step: TeamStepRecord, signal: AbortSignal, work: () => Promise<void>) {
    const key = `${step.id}:${crypto.randomUUID()}`;
    try {
      await this.scheduler.acquire(key, signal);
      if (!signal.aborted) await work();
    } catch (error) {
      if (!signal.aborted) throw error;
    } finally {
      this.scheduler.release(key);
    }
  }

  /**
   * 执行一次成员回合：创建流式群消息、同步状态与环境，结束后写回步骤。
   * 返回 undefined 表示被暂停/取消，或该步骤已标记失败。
   */
  private async turn(record: TeamRunRecord, step: TeamStepRecord, signal: AbortSignal, readOnly: boolean,
    structured: { plan?: ToolDefinition; verdict?: ToolDefinition },
    prompt: (context: TeamPromptContext) => string,
    planningDelegation = false): Promise<string | undefined> {
    const group = this.requireGroup(record);
    const bot = this.bot(step.botId);
    const now = Date.now();
    if (!bot) {
      Object.assign(step, { status: "failed", summary: runtimeText("team.error.empty_reply", { name: step.botId }), finishedAt: now });
      this.touch(record);
      return undefined;
    }
    const scope = this.host.scope(group, record, readOnly, planningDelegation);
    const context: TeamPromptContext = { group, botsById: new Map(this.host.bots().map((item) => [item.id, item])), bot, scope, history: this.host.history(record), record };
    const text = prompt(context);
    if (!step.resumed) Object.assign(step, { activity: [], targets: [], ...expectedTarget(scope) });
    Object.assign(step, { status: "running", startedAt: now, finishedAt: undefined, approval: undefined, summary: undefined });
    step.attempts++;
    const message: TeamMessage = { id: crypto.randomUUID(), groupId: group.id, senderKind: "bot", senderBotId: bot.id, content: "", mentions: [], mode: record.mode, streaming: true, createdAt: now };
    step.messageId = message.id;
    this.host.message(message);
    this.touch(record);
    this.acquireBot(group.id, bot.id);
    let streamed = "";
    const activityId = (callId: string) => `${step.attempts}:${callId}`;
    const observer: TeamTurnObserver = {
      delta: (value) => { streamed += value; this.host.delta(group.id, message.id, value); },
      toolStarted: (toolName, args, callId) => {
        const id = callId ? activityId(callId) : crypto.randomUUID();
        step.activity = appendActivity(step.activity, { ...activityOf(toolName, args), id });
        this.host.presence(group.id, bot.id, "working");
        this.touch(record);
      },
      toolFinished: (toolName, outcome, callId, detail) => {
        const activity = step.activity ?? [];
        const pending = [...activity].reverse().find((entry) =>
          entry.outcome === "running" && (callId ? entry.id === activityId(callId) : entry.tool === toolName));
        if (!pending) return;
        step.activity = activity.map((entry) => entry === pending ? { ...entry, outcome, ...(!entry.detail && detail ? { detail } : {}) } : entry);
        this.touch(record);
      },
      target: (target) => { Object.assign(step, withObservedTarget(step, target)); this.touch(record); },
      approval: (approval) => {
        step.approval = approval;
        this.host.presence(group.id, bot.id, approval ? "waiting" : "working");
        this.touch(record);
      },
    };
    try {
      const model = this.host.model(bot, record);
      // 固定声明 [team_plan, team_verdict] 维持跨步骤工具数组字节稳定，避免击穿 tools + systemPrompt 前缀缓存。
      const tools = [structured.plan ?? createTeamPlanTool(), structured.verdict ?? createVerdictTool()];
      const reply = await this.host.runner.run({
        sessionId: `team:${record.id}:${step.id}:${step.attempts}`, cacheKey: `team:${group.id}`, bot, prompt: text,
        ...(record.attachments?.length ? { attachments: record.attachments } : {}),
        model,
        ...(bot.thinking && model === bot.modelId ? { thinking: bot.thinking } : {}),
        permissionMode: record.defaults.permissionMode ?? "ask", scope, tools,
      }, observer, signal);
      if (signal.aborted) throw new TeamAbort("aborted");
      const content = reply.trim() || streamed.trim();
      this.host.message({ ...message, content: content || runtimeText("team.error.empty_reply", { name: bot.name }), streaming: false });
      Object.assign(step, { status: "completed", output: content, summary: oneLine(content) || undefined, finishedAt: Date.now(), approval: undefined, resumed: false });
      this.touch(record);
      return content;
    } catch (error) {
      if (signal.aborted) {
        // 保留被打断前的输出，供续跑摘要使用；步骤状态已由 pause/cancel 写入。
        step.output = streamed;
        this.host.message({ ...message, content: streamed.trim(), streaming: false });
        this.touch(record);
        return undefined;
      }
      const reason = error instanceof Error ? error.message : String(error);
      this.host.message({ ...message, content: streamed.trim() ? `${streamed.trim()}\n\n${reason}` : reason, streaming: false });
      Object.assign(step, { status: "failed", summary: oneLine(reason), output: streamed, finishedAt: Date.now(), approval: undefined });
      this.touch(record);
      return undefined;
    } finally {
      this.releaseBot(group.id, bot.id);
    }
  }

  private acquireBot(groupId: string, botId: string) {
    const key = `${groupId}\u0000${botId}`;
    this.busy.set(key, (this.busy.get(key) ?? 0) + 1);
    this.host.presence(groupId, botId, "thinking");
  }

  private releaseBot(groupId: string, botId: string) {
    const key = `${groupId}\u0000${botId}`;
    const count = (this.busy.get(key) ?? 1) - 1;
    if (count > 0) { this.busy.set(key, count); return; }
    this.busy.delete(key);
    this.host.presence(groupId, botId, "idle");
  }

  private bot(id: string) { return this.host.bots().find((bot) => bot.id === id); }

  private requireGroup(record: TeamRunRecord): TeamGroup {
    const group = this.host.group(record.groupId);
    if (!group) throw new Error(runtimeText("team.error.group_missing"));
    return group;
  }
}
