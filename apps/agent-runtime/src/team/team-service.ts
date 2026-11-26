import type { TeamRepo } from "@qone/database";
import {
  normalizeTeamExecution, type ModelConfigInfo, type RuntimeEvent, type ServerInfo, type TeamBot, type TeamBotPresence,
  type TeamCommand, type TeamGroup, type TeamMessage, type TeamRunCard, type TeamStateSnapshot,
} from "@qone/protocol";
import { runtimeError, runtimeText } from "../runtime-localization.js";
import { resolveExecutionScope } from "./team-environment.js";
import { TeamOrchestrator, type TeamTurnRunner } from "./team-orchestrator.js";
import { isLiveStatus, toRunCard, type TeamRunRecord } from "./team-records.js";
import { createRunRecord, resolveBotModel } from "./team-router.js";

const SNAPSHOT_MESSAGES = 200;
const SNAPSHOT_RUNS = 50;
const HISTORY_MESSAGES = 40;
const TERMINAL = new Set(["completed", "failed", "cancelled"]);

export interface TeamServiceDeps {
  repo: TeamRepo;
  runner: TeamTurnRunner;
  send(event: RuntimeEvent): void;
  servers(): readonly ServerInfo[];
  /** 已注册项目的本地路径。 */
  workspacePath(workspaceId: string | undefined): string | undefined;
  modelConfigs(): readonly ModelConfigInfo[];
  canChat(config: ModelConfigInfo): boolean;
  concurrency(): number;
}

/** 团队模式的命令入口：持久化、全量/增量推送，以及把群消息交给编排器。 */
export class TeamService {
  private readonly presence: Record<string, Record<string, TeamBotPresence>> = {};
  readonly orchestrator: TeamOrchestrator;

  constructor(private readonly deps: TeamServiceDeps) {
    this.orchestrator = new TeamOrchestrator({
      runner: deps.runner,
      group: (id) => this.findGroup(id),
      bots: () => this.bots(),
      scope: (group, record, readOnly, planningDelegation) => resolveExecutionScope(group.execution, deps.servers(), this.cwd(group, record), readOnly, planningDelegation),
      model: (bot, record) => resolveBotModel(bot, record.defaults, deps.modelConfigs(), deps.canChat),
      history: (record) => this.history(record),
      saveRun: (record) => { deps.repo.saveRun(record as unknown as TeamRunCard); deps.send({ type: "team.run.upsert", run: toRunCard(record) }); },
      message: (message) => { deps.repo.saveMessage(message); deps.send({ type: "team.message.append", message }); },
      delta: (groupId, messageId, delta) => deps.send({ type: "team.message.delta", groupId, messageId, delta }),
      presence: (groupId, botId, presence) => this.setPresence(groupId, botId, presence),
      concurrency: () => deps.concurrency(),
    });
    this.recover();
  }

  /** 上次进程退出时仍在运行的任务标为暂停，未收尾的流式消息定稿。 */
  private recover() {
    const note = runtimeText("team.note.interrupted");
    for (const run of this.deps.repo.listRunsByStatus<TeamRunRecord>(["queued", "planning", "running"])) {
      if (!run.phase) continue;
      const recovered = TeamOrchestrator.recover(run, note);
      this.deps.repo.saveRun(recovered as unknown as TeamRunCard);
      for (const step of recovered.steps) {
        const message = step.messageId ? this.deps.repo.getMessage(step.messageId) : undefined;
        if (message?.streaming) this.deps.repo.saveMessage({ ...message, streaming: false });
      }
    }
  }

  private cwd(group: TeamGroup, record: TeamRunRecord): string {
    return this.deps.workspacePath(group.execution.workspaceId) ?? this.deps.workspacePath(record.defaults.workspaceId) ?? process.cwd();
  }

  private history(record: TeamRunRecord): TeamMessage[] {
    // ponytail: 取最近 40 条再按触发时间截断，长任务中可用的早期上下文会变少；需要时改为按时间范围查询。
    return this.deps.repo.listMessages(HISTORY_MESSAGES, record.groupId).filter((message) => message.createdAt < record.startedAt);
  }

  private setPresence(groupId: string, botId: string, presence: TeamBotPresence) {
    const group = this.presence[groupId] ??= {};
    if (group[botId] === presence) return;
    group[botId] = presence;
    this.deps.send({ type: "team.bot.presence", groupId, botId, presence });
  }

  snapshot(): TeamStateSnapshot {
    const runs = this.deps.repo.listRuns<TeamRunRecord>(SNAPSHOT_RUNS).map((run) => this.orchestrator.live(run.id) ?? run);
    const bots = this.bots();
    const known = new Set(bots.map((bot) => bot.id));
    return {
      bots,
      groups: this.deps.repo.listGroups().map((group) => this.normalizeGroup(group, known)),
      messages: this.deps.repo.listMessages(SNAPSHOT_MESSAGES),
      runs: runs.map((run) => run.phase ? toRunCard(run) : run as unknown as TeamRunCard),
      presence: this.presence,
    };
  }

  broadcast(requestId?: string) {
    this.deps.send({ type: "team.state", ...(requestId ? { requestId } : {}), state: this.snapshot() });
  }

  private static isTeamBot(bot: TeamBot): boolean {
    return bot.source !== "subagent" && !bot.linkedSubagentId;
  }

  private bots(): TeamBot[] {
    // 旧版同步记录仍留在数据库中，但不会进入成员列表或执行队列。
    return this.deps.repo.listBots().filter(TeamService.isTeamBot);
  }

  /** 成员只保留仍存在的团队机器人，统筹必须是成员之一。 */
  private normalizeGroup(group: TeamGroup, known = new Set(this.bots().map((bot) => bot.id))): TeamGroup {
    const candidates = group.directBotId ? [group.directBotId] : group.memberBotIds;
    const memberBotIds = [...new Set(candidates)].filter((id) => known.has(id));
    const coordinatorBotId = memberBotIds.includes(group.coordinatorBotId) ? group.coordinatorBotId : memberBotIds[0] ?? "";
    return { ...group, name: group.name.trim(), memberBotIds, coordinatorBotId, execution: normalizeTeamExecution(group.execution) };
  }

  private findGroup(id: string): TeamGroup | undefined {
    const group = this.deps.repo.getGroup(id);
    return group && this.normalizeGroup(group);
  }

  private requireGroup(id: string): TeamGroup {
    const group = this.findGroup(id);
    if (!group) throw runtimeError("team.error.group_missing");
    return group;
  }

  async handle(cmd: TeamCommand & { locale?: "en" | "zh-CN" }): Promise<void> {
    const { repo } = this.deps;
    switch (cmd.type) {
      case "team.state.get":
        return this.broadcast(cmd.requestId);
      case "team.state.import":
        if (repo.isEmpty()) this.importState(cmd.state);
        return this.broadcast(cmd.requestId);
      case "team.bot.save": {
        const existing = repo.getBot(cmd.bot.id);
        if (!TeamService.isTeamBot(cmd.bot) || (existing && !TeamService.isTeamBot(existing))) {
          throw runtimeError("team.error.subagent_separate");
        }
        repo.saveBot({ ...cmd.bot, name: cmd.bot.name.trim(), createdAt: existing?.createdAt ?? cmd.bot.createdAt });
        return this.broadcast(cmd.requestId);
      }
      case "team.bot.delete":
        repo.transaction(() => {
          repo.deleteBot(cmd.botId);
          for (const group of repo.listGroups()) {
            if (group.memberBotIds.includes(cmd.botId)) repo.saveGroup({ ...this.normalizeGroup(group), updatedAt: Date.now() });
          }
        });
        return this.broadcast(cmd.requestId);
      case "team.group.create":
        if (!repo.getGroup(cmd.group.id)) repo.saveGroup(this.normalizeGroup(cmd.group));
        return this.broadcast(cmd.requestId);
      case "team.group.update": {
        const group = this.requireGroup(cmd.groupId);
        repo.saveGroup(this.normalizeGroup({ ...group, ...cmd.patch, id: group.id, createdAt: group.createdAt, updatedAt: Date.now() }));
        return this.broadcast(cmd.requestId);
      }
      case "team.group.delete":
        await this.orchestrator.stopGroup(cmd.groupId);
        repo.deleteGroup(cmd.groupId);
        delete this.presence[cmd.groupId];
        return this.broadcast(cmd.requestId);
      case "team.group.clear":
        await this.orchestrator.stopGroup(cmd.groupId);
        repo.clearGroup(cmd.groupId);
        delete this.presence[cmd.groupId];
        return this.broadcast(cmd.requestId);
      case "team.message.send":
        return this.send(cmd);
      case "team.run.action":
        return this.runAction(cmd.runId, cmd.action, cmd.requestId);
    }
  }

  private send(cmd: Extract<TeamCommand, { type: "team.message.send" }> & { locale?: "en" | "zh-CN" }) {
    const group = this.requireGroup(cmd.groupId);
    const now = Date.now();
    const runId = crypto.randomUUID();
    const message: TeamMessage = {
      id: cmd.messageId, groupId: group.id, senderKind: "user", content: cmd.content.trim(), mentions: cmd.mentions,
      ...(cmd.attachments?.length ? { attachments: cmd.attachments } : {}),
      ...(cmd.replyToMessageId ? { replyToMessageId: cmd.replyToMessageId } : {}), runCardId: runId, mode: cmd.mode ?? group.mode, createdAt: now,
    };
    this.deps.repo.saveMessage(message);
    this.deps.repo.saveGroup({ ...group, updatedAt: now });
    this.deps.send({ type: "team.message.append", message });
    const defaults = cmd.defaults ?? {};
    const record = createRunRecord({
      id: runId, group, bots: this.bots(), message, defaults, locale: cmd.locale, now,
      scope: resolveExecutionScope(group.execution, this.deps.servers(), this.deps.workspacePath(group.execution.workspaceId) ?? this.deps.workspacePath(defaults.workspaceId) ?? process.cwd(), false),
    });
    if (!this.deps.modelConfigs().some((config) => config.enabled && this.deps.canChat(config)) && isLiveStatus(record.status)) {
      Object.assign(record, { status: "failed", phase: "done", finishedAt: now, note: runtimeText("team.error.no_model") });
    }
    this.orchestrator.start(record);
    this.deps.send({ type: "pong", requestId: cmd.requestId });
  }

  private runAction(runId: string, action: "pause" | "resume" | "cancel" | "confirm_plan", requestId: string) {
    const record = this.orchestrator.live(runId) ?? this.deps.repo.getRun<TeamRunRecord>(runId);
    if (!record?.phase) throw runtimeError("team.error.run_missing");
    if (action === "pause") this.orchestrator.pause(record);
    else if (action === "cancel") this.orchestrator.cancel(record);
    else if (action === "resume") this.orchestrator.resume(record);
    else this.orchestrator.confirm(record);
    this.deps.send({ type: "pong", requestId });
  }

  /** 首次启动承接旧版本地数据：只在四张表都为空时整体导入，未结束的旧任务按已取消处理。 */
  private importState(state: Omit<TeamStateSnapshot, "presence">) {
    const { repo } = this.deps;
    repo.transaction(() => {
      for (const bot of state.bots) if (TeamService.isTeamBot(bot)) repo.saveBot(bot);
      const groupIds = new Set<string>();
      for (const group of state.groups) { repo.saveGroup(this.normalizeGroup(group)); groupIds.add(group.id); }
      for (const message of state.messages) if (groupIds.has(message.groupId)) repo.saveMessage({ ...message, streaming: false });
      for (const run of state.runs) {
        if (!groupIds.has(run.groupId)) continue;
        repo.saveRun(TERMINAL.has(run.status) ? run : { ...run, status: "cancelled", finishedAt: run.finishedAt ?? run.updatedAt });
      }
    });
  }
}
