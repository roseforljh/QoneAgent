import { describe, expect, test } from "bun:test";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { closeDb, openDb, TeamRepo } from "@qone/database";
import type { RuntimeEvent, ServerInfo, TeamBot, TeamGroup, TeamMentionRef } from "@qone/protocol";
import { TeamService } from "../src/team/team-service";
import type { TeamTurnObserver, TeamTurnRequest, TeamTurnRunner } from "../src/team/team-orchestrator";
import type { TeamRunRecord } from "../src/team/team-records";
import { snapshotDb } from "./db-snapshot";

const bot = (id: string, name: string, extra: Partial<TeamBot> = {}): TeamBot => ({
  id, name, roleTitle: name, description: "", systemPrompt: `${name} 的人设`, logo: "robot", modelId: "", capabilities: [], source: "custom", createdAt: 1, updatedAt: 1, ...extra,
});
const coordinator = bot("coord", "小策");
const engineer = bot("eng", "小码", { modelId: "p/strong" });
const reviewer = bot("rev", "小审");
const coordinatorMention: TeamMentionRef = { kind: "bot", targetId: coordinator.id, label: coordinator.name };
const server: ServerInfo = { id: "srv-1", name: "prod-1", host: "10.0.0.1", port: 22, username: "root", auth: { kind: "agent" }, status: "ready", system: "Debian 13", createdAt: 1 };

type Script = (request: TeamTurnRequest, observer: TeamTurnObserver, signal: AbortSignal) => Promise<string>;

/** 按机器人脚本化的回合执行器：记录每次请求，模拟真实运行时的工具事件。 */
class ScriptedRunner implements TeamTurnRunner {
  readonly requests: TeamTurnRequest[] = [];
  constructor(private readonly scripts: Record<string, Script[]>) {}
  run(request: TeamTurnRequest, observer: TeamTurnObserver, signal: AbortSignal) {
    this.requests.push(request);
    const next = this.scripts[request.bot.id]?.shift();
    if (!next) throw new Error(`no script for ${request.bot.id}`);
    return next(request, observer, signal);
  }
}

const tool = (request: TeamTurnRequest, name: string): ToolDefinition => {
  const found = request.tools.find((item) => item.name === name);
  if (!found) throw new Error(`${name} missing`);
  return found;
};
const call = (request: TeamTurnRequest, name: string, args: unknown) => tool(request, name).execute("call-1", args as never, undefined, undefined, undefined as never);
const reply = (text: string): Script => async (_request, observer) => { observer.delta(text); return text; };

async function until(check: () => boolean, label: string) {
  for (let i = 0; i < 400; i++) {
    if (check()) return;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

function setup(scripts: Record<string, Script[]>, group: Partial<TeamGroup> = {}) {
  const db = openDb(":memory:");
  const repo = new TeamRepo(db);
  const events: RuntimeEvent[] = [];
  const runner = new ScriptedRunner(scripts);
  for (const item of [coordinator, engineer, reviewer]) repo.saveBot(item);
  repo.saveGroup({
    id: "g1", name: "研发群", description: "", announcement: "改动必须经过审查", memberBotIds: ["coord", "eng", "rev"], coordinatorBotId: "coord",
    mode: "execute", maxAutoRounds: 6, execution: { allowLocal: true, serverIds: ["srv-1"], strategy: "smart" }, createdAt: 1, updatedAt: 1, ...group,
  });
  const service = new TeamService({
    repo, runner, send: (event) => events.push(event), servers: () => [server],
    workspacePath: (id) => id === "ws" ? "C:/work/project" : undefined,
    modelConfigs: () => [
      { id: "p/default", provider: "p", model: "default", config: {}, enabled: true, updatedAt: 0 },
      { id: "p/strong", provider: "p", model: "strong", config: {}, enabled: true, updatedAt: 0 },
    ],
    canChat: () => true, concurrency: () => 4,
  });
  const send = (content: string, mentions: TeamMentionRef[] = [], groupId = "g1") => service.handle({
    type: "team.message.send", requestId: crypto.randomUUID(), groupId, messageId: crypto.randomUUID(), content, mentions,
    defaults: { model: "p/default", permissionMode: "ask", workspaceId: "ws" },
  });
  const run = () => repo.listRuns<TeamRunRecord>(10).at(-1)!;
  return { db, repo, events, runner, service, send, run };
}

describe("team orchestration", () => {
  test("previously linked subagents stay out of rosters and runs without deleting team history", async () => {
    const legacy = bot("linked-agent", "旧子代理", { source: "subagent", linkedSubagentId: "settings-agent" });
    const ctx = setup({ coord: [reply("由团队成员接手")] }, {
      memberBotIds: [legacy.id, coordinator.id], coordinatorBotId: legacy.id,
    });
    try {
      ctx.repo.saveBot(legacy);
      ctx.repo.saveMessage({ id: "old-reply", groupId: "g1", senderKind: "bot", senderBotId: legacy.id, content: "旧回复", mentions: [], createdAt: 1 });
      const state = ctx.service.snapshot();
      expect(state.bots.map(({ id }) => id)).not.toContain(legacy.id);
      expect(state.groups[0]).toMatchObject({ memberBotIds: [coordinator.id], coordinatorBotId: coordinator.id });
      expect(state.messages[0]).toMatchObject({ id: "old-reply", content: "旧回复" });
      await expect(ctx.service.handle({ type: "team.bot.save", requestId: "sync", bot: legacy })).rejects.toThrow();
      await ctx.send("@旧子代理 继续", [{ kind: "bot", targetId: legacy.id, label: legacy.name }]);
      await until(() => ctx.run()?.status === "completed", "team-only run");
      expect(ctx.runner.requests.map(({ bot }) => bot.id)).toEqual([coordinator.id]);
      expect(ctx.repo.getBot(legacy.id)).toEqual(legacy);
    } finally {
      closeDb(ctx.db);
    }
  });

  test("the coordinator plans, members execute by dependency, a failed check is repaired and rechecked, then the coordinator summarizes", async () => {
    let verdicts = 0;
    const ctx = setup({
      coord: [
        async (request) => {
          expect(request.scope.readOnly).toBe(true);
          expect(request.prompt).toContain("改动必须经过审查");
          await call(request, "team_plan", { steps: [
            { id: "s1", botId: "eng", title: "实现接口", task: "实现 /health 接口" },
            { id: "s2", botId: "rev", title: "审查接口", task: "审查 /health 接口", verifies: "s1" },
          ] });
          return "已拆分为实现与审查两步。";
        },
        async (request, observer) => {
          expect(request.scope.readOnly).toBe(true);
          expect(request.prompt).toContain("status=\"completed\"");
          observer.delta("接口已实现并通过复验。");
          return "接口已实现并通过复验。";
        },
      ],
      eng: [
        async (request, observer) => {
          expect(request.model).toBe("p/strong");
          expect(request.scope.readOnly).toBe(false);
          observer.toolStarted("write", { path: "src/health.ts" }, "health");
          observer.toolStarted("write", { path: "src/status.ts" }, "status");
          observer.target({ kind: "local" });
          observer.toolFinished("write", "done", "health");
          observer.toolFinished("write", "failed", "status");
          return "已在本机写入 src/health.ts";
        },
        async (request) => {
          expect(request.prompt).toContain("缺少超时处理");
          return "已补充超时处理";
        },
      ],
      rev: [
        async (request) => {
          expect(request.prompt).toContain("已在本机写入 src/health.ts");
          verdicts++;
          await call(request, "team_verdict", { verdict: "fail", failures: ["缺少超时处理"] });
          return "不通过";
        },
        async (request) => {
          expect(request.prompt).toContain("recheck");
          verdicts++;
          await call(request, "team_verdict", { verdict: "pass", failures: [] });
          return "通过";
        },
      ],
    });
    await ctx.send("@小策 给服务加健康检查接口", [coordinatorMention]);
    await until(() => ctx.run()?.status === "completed", "run completion");
    const record = ctx.run();
    expect(verdicts).toBe(2);
    expect(record.steps.map((step) => `${step.kind}:${step.botId}:${step.status}`)).toEqual([
      "plan:coord:completed", "work:eng:completed", "verify:rev:completed", "work:eng:completed", "verify:rev:completed", "summary:coord:completed",
    ]);
    expect(record.roundsUsed).toBe(4);
    expect(record.steps[1]).toMatchObject({ targetKind: "local", targets: [{ kind: "local" }] });
    expect(ctx.repo.listMessages(50, "g1").filter((message) => message.senderKind === "bot").map((message) => message.content).at(-1)).toBe("接口已实现并通过复验。");
    expect(ctx.events.some((event) => event.type === "team.message.delta")).toBe(true);
    const activity = ctx.events.flatMap((event) => event.type === "team.run.upsert" ? event.run.steps.find((step) => step.id === "s1")?.activity ?? [] : []);
    expect(activity).toContainEqual({ id: "1:health", tool: "write", detail: "src/health.ts", outcome: "running" });
    expect(activity).toContainEqual({ id: "1:health", tool: "write", detail: "src/health.ts", outcome: "done" });
    expect(activity).toContainEqual({ id: "1:status", tool: "write", detail: "src/status.ts", outcome: "failed" });
    expect(ctx.events.filter((event) => event.type === "team.bot.presence" && event.botId === "eng").at(-1)).toMatchObject({ presence: "idle" });
    closeDb(ctx.db);
  });

  test("a coordinator that needs no members answers directly", async () => {
    const ctx = setup({ coord: [reply("你好，我是统筹。")] });
    await ctx.send("@小策 你好", [coordinatorMention]);
    await until(() => ctx.run()?.status === "completed", "direct reply");
    expect(ctx.run().steps.map((step) => step.kind)).toEqual(["plan"]);
    expect(ctx.runner.requests).toHaveLength(1);
    closeDb(ctx.db);
  });

  test("mentioned members respond in parallel and only the mentioned ones are woken", async () => {
    const ctx = setup({ eng: [reply("工程意见")], rev: [reply("审查意见")], coord: [reply("汇总")] });
    await ctx.send("@小码 @小审 看下方案", [
      { kind: "bot", targetId: "eng", label: "小码" }, { kind: "bot", targetId: "rev", label: "小审" },
    ]);
    await until(() => ctx.run()?.status === "completed", "mention run");
    expect(ctx.run().route).toBe("mentions");
    expect(ctx.run().steps.map((step) => step.kind)).toEqual(["respond", "respond", "summary"]);
    expect(ctx.runner.requests.slice(0, 2).every((request) => request.prompt.includes("Answer only your part"))).toBe(true);
    closeDb(ctx.db);
  });

  test("messages without a mention default to the coordinator for reply or delegation", async () => {
    const ctx = setup({ coord: [reply("我先统筹处理。")], eng: [reply("工程意见")], rev: [reply("审查意见")] });
    try {
      await ctx.send("帮我看看后端状态", []);
      await until(() => ctx.run()?.status === "completed", "default coordinator reply");
      expect(ctx.run().route).toBe("coordinator");
      expect(ctx.run().steps.map(({ kind, botId }) => `${kind}:${botId}`)).toEqual(["plan:coord"]);
      expect(ctx.runner.requests.map(({ bot }) => bot.id)).toEqual(["coord"]);
      expect(ctx.repo.listMessages(50, "g1").filter((message) => message.senderKind === "bot")).toHaveLength(1);
    } finally {
      closeDb(ctx.db);
    }
  });

  test("broadcast with @everyone reaches every member without consuming delegation rounds", async () => {
    const ctx = setup({ coord: [reply("统筹意见")], eng: [reply("工程意见")], rev: [reply("审查意见")] }, { maxAutoRounds: 1 });
    try {
      await ctx.send("汇报", [{ kind: "all", targetId: "all", label: "全体成员" }]);
      await until(() => ctx.run()?.status === "completed", "broadcast replies");
      expect(ctx.run().route).toBe("all");
      expect(ctx.run().roundsUsed).toBe(0);
      expect(ctx.run().steps.map(({ kind, botId }) => `${kind}:${botId}`)).toEqual(["respond:coord", "respond:eng", "respond:rev"]);
      expect(ctx.runner.requests.every(({ prompt }) => prompt.includes("<user-request>\n汇报\n"))).toBe(true);
      expect(ctx.repo.listMessages(50, "g1").filter((message) => message.senderKind === "bot")).toHaveLength(3);
    } finally {
      closeDb(ctx.db);
    }
  });

  test("private conversations persist separately and cannot add other bots", async () => {
    const ctx = setup({ eng: [async (request) => {
      expect(request.prompt).toContain("private conversation");
      expect(request.prompt).toContain("旧私聊");
      expect(request.prompt).not.toContain("普通群消息");
      expect(request.model).toBe("p/strong");
      return "私聊回复";
    }] });
    try {
      const groupId = "private-chat";
      const group = { ...ctx.repo.getGroup("g1")!, id: groupId, directBotId: engineer.id };
      await ctx.service.handle({ type: "team.group.create", requestId: "direct", group });
      await ctx.service.handle({ type: "team.group.create", requestId: "replace", group: { ...group, directBotId: reviewer.id } });
      await ctx.service.handle({ type: "team.group.update", requestId: "add", groupId, patch: { memberBotIds: [reviewer.id], coordinatorBotId: reviewer.id } });
      ctx.repo.saveMessage({ id: "old-direct", groupId, senderKind: "user", content: "旧私聊", mentions: [], createdAt: 2 });
      ctx.repo.saveMessage({ id: "old-group", groupId: "g1", senderKind: "user", content: "普通群消息", mentions: [], createdAt: 2 });
      await ctx.send("@小策 你好", [coordinatorMention], groupId);
      await until(() => ctx.run()?.status === "completed", "private reply");
      expect(new TeamRepo(ctx.db).getGroup(groupId)).toMatchObject({ directBotId: engineer.id, memberBotIds: [engineer.id], coordinatorBotId: engineer.id });
      expect(ctx.runner.requests.map(({ bot }) => bot.id)).toEqual([engineer.id]);
      expect(ctx.repo.listMessages(50, groupId).map(({ content }) => content)).toEqual(["旧私聊", "@小策 你好", "私聊回复"]);
      expect(ctx.repo.listMessages(50, "g1").map(({ content }) => content)).toEqual(["普通群消息"]);
    } finally {
      closeDb(ctx.db);
    }
  });

  test("planning mode waits for confirmation, then executes with write access", async () => {
    const ctx = setup({
      coord: [
        async (request) => { await call(request, "team_plan", { steps: [{ id: "s1", botId: "eng", title: "部署", task: "部署服务" }] }); return "计划如下"; },
        reply("部署完成"),
      ],
      eng: [async (request) => { expect(request.scope.readOnly).toBe(false); return "已部署"; }],
    }, { mode: "plan" });
    await ctx.send("@小策 部署服务", [coordinatorMention]);
    await until(() => ctx.run()?.status === "awaiting_confirmation", "plan card");
    expect(ctx.run().steps.filter((step) => step.kind === "work").map((step) => step.status)).toEqual(["awaiting"]);
    expect(ctx.runner.requests).toHaveLength(1);
    await ctx.service.handle({ type: "team.run.action", requestId: "a", runId: ctx.run().id, action: "confirm_plan" });
    await until(() => ctx.run()?.status === "completed", "confirmed run");
    closeDb(ctx.db);
  });

  test("pause keeps finished steps, resume reruns the interrupted step with a summary of what it did", async () => {
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    const ctx = setup({
      eng: [
        (_request, observer, signal) => new Promise((_resolve, reject) => {
          observer.toolStarted("powershell", { command: "npm run build" });
          started();
          signal.addEventListener("abort", () => reject(new Error("aborted")));
        }),
        async (request) => {
          expect(request.prompt).toContain("interrupted by a pause");
          expect(request.prompt).toContain("powershell: npm run build → stopped by the pause");
          return "构建完成";
        },
      ],
    });
    await ctx.send("@小码 构建", [{ kind: "bot", targetId: "eng", label: "小码" }]);
    await begun;
    const runId = ctx.run().id;
    await ctx.service.handle({ type: "team.run.action", requestId: "p", runId, action: "pause" });
    expect(ctx.run().status).toBe("paused");
    expect(ctx.run().steps[0].status).toBe("paused");
    await ctx.service.handle({ type: "team.run.action", requestId: "r", runId, action: "resume" });
    await until(() => ctx.run()?.status === "completed", "resumed run");
    expect(ctx.run().steps[0]).toMatchObject({ status: "completed", attempts: 2, output: "构建完成" });
    closeDb(ctx.db);
  });
});

describe("team persistence", () => {
  test("groups, bots, messages and run cards survive a restart; interrupted runs come back paused", async () => {
    const ctx = setup({ eng: [(_request, _observer, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("stop"))))] });
    await ctx.send("@小码 长任务", [{ kind: "bot", targetId: "eng", label: "小码" }]);
    await until(() => ctx.run()?.steps[0]?.status === "running", "running step");
    const file = snapshotDb(ctx.db);
    await ctx.service.orchestrator.stopGroup("g1");
    closeDb(ctx.db);

    const db = openDb(file);
    const repo = new TeamRepo(db);
    const service = new TeamService({
      repo, runner: new ScriptedRunner({}), send: () => undefined, servers: () => [], workspacePath: () => undefined,
      modelConfigs: () => [], canChat: () => true, concurrency: () => 1,
    });
    const state = service.snapshot();
    expect(state.groups.map((group) => group.name)).toEqual(["研发群"]);
    expect(state.bots.map((item) => item.id).sort()).toEqual(["coord", "eng", "rev"]);
    expect(state.messages.some((message) => message.content === "@小码 长任务")).toBe(true);
    expect(state.messages.every((message) => !message.streaming)).toBe(true);
    expect(state.runs[0]).toMatchObject({ status: "paused" });
    expect(state.runs[0].steps[0].status).toBe("paused");
    expect(Object.keys(state.runs[0])).not.toContain("phase");
    repo.clearGroup("g1");
    expect(service.snapshot().messages).toEqual([]);
    closeDb(db);
  });

  test("legacy local data is imported only into empty tables", async () => {
    const db = openDb(":memory:");
    const repo = new TeamRepo(db);
    const service = new TeamService({ repo, runner: new ScriptedRunner({}), send: () => undefined, servers: () => [], workspacePath: () => undefined, modelConfigs: () => [], canChat: () => true, concurrency: () => 1 });
    const group: TeamGroup = { id: "legacy", name: "旧群", description: "", announcement: "", memberBotIds: ["eng"], coordinatorBotId: "eng", mode: "execute", maxAutoRounds: 6, execution: { allowLocal: true, serverIds: [], strategy: "smart" }, createdAt: 1, updatedAt: 1 };
    const state = {
      bots: [engineer], groups: [group], messages: [],
      runs: [{ id: "old", groupId: "legacy", triggerMessageId: "m", title: "t", coordinatorBotId: "eng", status: "awaiting_runtime" as const, mode: "execute" as const, strategy: "smart" as const, targetServerIds: [], allowLocal: true, steps: [], startedAt: 1, updatedAt: 1 }],
    };
    await service.handle({ type: "team.state.import", requestId: "i", state });
    expect(repo.listRuns(10)[0].status).toBe("cancelled");
    await service.handle({ type: "team.state.import", requestId: "j", state: { ...state, bots: [coordinator] } });
    expect(repo.listBots().map((item) => item.id)).toEqual(["eng"]);
    closeDb(db);
  });
});
