import { describe, expect, test } from "bun:test";
import type { ServerInfo, TeamBot, TeamGroup } from "@qone/protocol";
import type { IsolatedSessionPolicy } from "../src/pi-adapter";
import { PiTeamTurnRunner } from "../src/team/team-agent-runner";
import { expectedTarget, observedTarget, resolveExecutionScope, teamToolDenial } from "../src/team/team-environment";
import { validateTeamPlan } from "../src/team/team-plan-engine";
import { resolveBotModel, routeMessage } from "../src/team/team-router";
import type { TeamTurnObserver } from "../src/team/team-orchestrator";

const server = (id: string, name: string): ServerInfo => ({ id, name, host: "10.0.0.1", port: 22, username: "root", auth: { kind: "agent" }, status: "ready", createdAt: 1 });
const registry = [server("a", "prod-a"), server("b", "prod-b")];
const bot = (id: string): TeamBot => ({ id, name: id, roleTitle: id, description: "", systemPrompt: "", logo: "robot", modelId: "", capabilities: [], source: "custom", createdAt: 1, updatedAt: 1 });
const bots = [bot("coord"), bot("eng"), bot("rev")];
const group: TeamGroup = {
  id: "g", name: "g", description: "", announcement: "", memberBotIds: ["coord", "eng", "rev"], coordinatorBotId: "coord",
  mode: "execute", maxAutoRounds: 6, execution: { allowLocal: true, serverIds: ["a"], strategy: "smart" }, createdAt: 1, updatedAt: 1,
};

describe("team routing", () => {
  test("broadcasts reach all members and explicitly mentioning the coordinator opens planning", () => {
    expect(routeMessage(group, bots, [{ kind: "bot", targetId: "rev", label: "rev" }])).toEqual({ route: "mentions", botIds: ["rev"] });
    expect(routeMessage(group, bots, [{ kind: "all", targetId: "all", label: "all" }])).toEqual({ route: "all", botIds: ["coord", "eng", "rev"] });
    expect(routeMessage(group, bots, [{ kind: "bot", targetId: "coord", label: "coord" }])).toEqual({ route: "coordinator", botIds: ["coord"] });
    expect(routeMessage(group, bots, [{ kind: "bot", targetId: "stranger", label: "x" }])).toEqual({ route: "coordinator", botIds: ["coord"] });
    expect(routeMessage(group, bots, [])).toEqual({ route: "coordinator", botIds: ["coord"] });
  });

  test("bot models follow the bot, then the global selection, and skip unusable models", () => {
    const configs = [
      { id: "p/a", provider: "p", model: "a", config: {}, enabled: true, updatedAt: 0 },
      { id: "p/off", provider: "p", model: "off", config: {}, enabled: false, updatedAt: 0 },
      { id: "p/image", provider: "p", model: "image", config: {}, enabled: true, updatedAt: 0 },
    ];
    const canChat = (config: { id: string }) => config.id !== "p/image";
    expect(resolveBotModel({ modelId: "p/a" }, { model: "p/image" }, configs, canChat)).toBe("p/a");
    expect(resolveBotModel({ modelId: "" }, { model: "p/a" }, configs, canChat)).toBe("p/a");
    expect(resolveBotModel({ modelId: "p/off" }, { model: "p/image" }, configs, canChat)).toBe("p/a");
  });

  test("plans are validated by the program", () => {
    const context = { members: bots, coordinatorBotId: "coord", remainingRounds: 3 };
    const step = (id: string, botId: string, extra = {}) => ({ id, botId, title: id, task: id, ...extra });
    expect(validateTeamPlan({ steps: [step("s1", "ghost")] }, context)).toMatchObject({ ok: false });
    expect(validateTeamPlan({ steps: [step("s1", "coord")] }, context)).toMatchObject({ ok: false });
    expect(validateTeamPlan({ steps: [step("s1", "eng"), step("s2", "eng", { verifies: "s1" })] }, context)).toMatchObject({ ok: false });
    expect(validateTeamPlan({ steps: [step("s1", "eng", { dependsOn: ["s2"] }), step("s2", "rev", { dependsOn: ["s1"] })] }, context)).toMatchObject({ ok: false });
    expect(validateTeamPlan({ steps: [step("s1", "eng"), step("s2", "rev"), step("s3", "eng"), step("s4", "rev")] }, context)).toMatchObject({ ok: false });
    const ok = validateTeamPlan({ steps: [step("s1", "eng"), step("s2", "rev", { verifies: "s1" })] }, context);
    expect(ok).toMatchObject({ ok: true });
    if (ok.ok) expect(ok.steps[1].dependsOn).toEqual(["s1"]);
    // 兼容 OpenAI / Codex 模型传 null、空 verifies 以及传成员名作为 botId
    const namedBots = [
      { ...bot("coord"), name: "小策" },
      { ...bot("eng"), name: "小维" },
      { ...bot("rev"), name: "小审" },
    ];
    const tolerant = validateTeamPlan({
      steps: [
        { id: "s1", botId: "@小维", title: "排查服务器", task: "检查磁盘占用", dependsOn: null, verifies: "" },
        { id: "s2", botId: "小审", title: "复核", task: "复核清理项", dependsOn: null, verifies: null },
      ],
    }, { members: namedBots, coordinatorBotId: "coord", remainingRounds: 4 });
    expect(tolerant).toMatchObject({ ok: true });
    if (tolerant.ok) {
      expect(tolerant.steps.map((s) => s.botId)).toEqual(["eng", "rev"]);
      expect(tolerant.steps[0].dependsOn).toEqual([]);
      expect(tolerant.steps[0].verifies).toBeUndefined();
      expect(tolerant.steps[1].verifies).toBeUndefined();
    }
  });
});

describe("team execution environment", () => {
  test("strategies decide which servers and local permissions a member gets", () => {
    expect(resolveExecutionScope({ allowLocal: true, serverIds: ["a"], strategy: "local-only" }, registry, "C:/w", false))
      .toMatchObject({ servers: [], localWrite: true });
    expect(resolveExecutionScope({ allowLocal: false, serverIds: [], strategy: "smart" }, registry, "C:/w", false))
      .toMatchObject({ servers: [], localWrite: true });
    const smart = resolveExecutionScope({ allowLocal: true, serverIds: ["a", "b", "gone"], strategy: "smart" }, registry, "C:/w", false);
    expect(smart.servers.map((item) => item.id)).toEqual(["a", "b"]);
    expect(expectedTarget(smart)).toEqual({ targetKind: "auto" });
    const remoteOnly = resolveExecutionScope({ allowLocal: false, serverIds: ["b"], strategy: "servers-preferred" }, registry, "C:/w", false);
    expect(remoteOnly.localWrite).toBe(false);
    expect(expectedTarget(remoteOnly)).toEqual({ targetKind: "server", targetId: "b", targetLabel: "prod-b" });
  });

  test("the tool gate isolates local writes and keeps planning turns read-only", () => {
    const remoteOnly = resolveExecutionScope({ allowLocal: false, serverIds: ["a"], strategy: "smart" }, registry, process.cwd(), false);
    expect(teamToolDenial(remoteOnly, "powershell", { command: "dir" })).toBeString();
    expect(teamToolDenial(remoteOnly, "write", { path: "a.txt", content: "" })).toBeString();
    expect(teamToolDenial(remoteOnly, "read", { path: "a.txt" })).toBeUndefined();
    expect(teamToolDenial(remoteOnly, "server_exec", { server: "a", command: "rm -rf /tmp/x" })).toBeUndefined();
    const planning = { ...remoteOnly, localWrite: true, readOnly: true };
    expect(teamToolDenial(planning, "server_exec", { server: "a", command: "df -h" })).toBeUndefined();
    expect(teamToolDenial(planning, "server_exec", { server: "a", command: "systemctl restart nginx" })).toBeString();
    expect(teamToolDenial(planning, "edit", { path: "a.txt" })).toBeString();
    expect(teamToolDenial(planning, "grep", { pattern: "x" })).toBeUndefined();
    const delegating = { ...planning, planningDelegation: true };
    expect(teamToolDenial(delegating, "server_exec", { server: "a", command: "df -h" })).toContain("team_plan");
    expect(teamToolDenial(delegating, "server_read_file", { server: "a", path: "/var/log/syslog" })).toContain("team_plan");
  });

  test("targets come only from runtime results, never from model arguments", () => {
    expect(observedTarget("server_exec", { details: { serverOperation: { serverId: "a", serverName: "prod-a" } } })).toEqual({ kind: "server", id: "a", label: "prod-a" });
    expect(observedTarget("server_exec", { content: [], details: {} })).toBeUndefined();
    expect(observedTarget("powershell", { details: { denied: true } })).toBeUndefined();
    expect(observedTarget("powershell", { content: [] })).toEqual({ kind: "local" });
  });
});

describe("pi team turn runner", () => {
  test("isolated sessions get the gate and structured tools; bus events become text, targets and approvals", async () => {
    let resolver: ((sessionId: string) => IsolatedSessionPolicy | undefined) | undefined;
    const runner = new PiTeamTurnRunner({
      setIsolatedSessionResolver: (resolve) => { resolver = resolve; },
      stop: () => true,
      run: async (sessionId, _message, opts) => {
        const policy = resolver?.(sessionId);
        expect(policy?.gate("powershell", { command: "dir" })).toBeString();
        expect(policy?.tools?.map((item) => item.name)).toEqual(["team_verdict"]);
        expect(opts.serverIds).toEqual(["a"]);
        const emit = (type: string, payload: unknown) => expect(runner.observe({ type, payload, sessionId, runId: opts.runId })).toBe(true);
        emit("message.started", {});
        emit("message.delta", { delta: "检查中", contentIndex: 0 });
        emit("message.delta", { blockType: "tool-call", args: {} });
        emit("tool.started", { toolName: "server_exec", args: { server: "b", command: "df -h" } });
        emit("approval.requested", { approvalId: "ap1", toolName: "server_exec", args: { command: "df -h" } });
        emit("approval.resolved", { approvalId: "ap1", approved: true });
        emit("tool.completed", { toolName: "server_exec", result: { details: { serverOperation: { serverId: "a", serverName: "prod-a" } } } });
        emit("message.started", {});
        emit("message.completed", { message: { role: "assistant", content: [{ type: "text", text: "磁盘正常" }] } });
      },
    });
    const seen: string[] = [];
    const observer: TeamTurnObserver = {
      delta: (text) => seen.push(`delta:${text}`),
      toolStarted: (name) => seen.push(`start:${name}`),
      toolFinished: (name, outcome) => seen.push(`end:${name}:${outcome}`),
      target: (target) => seen.push(`target:${target.kind}:${target.id}`),
      approval: (approval) => seen.push(`approval:${approval?.approvalId ?? "none"}:${approval?.detail ?? ""}`),
    };
    const scope = resolveExecutionScope({ allowLocal: false, serverIds: ["a"], strategy: "smart" }, registry, process.cwd(), false);
    const verdict = { name: "team_verdict", label: "v", description: "v", parameters: {} as never, execute: async () => ({ content: [], details: {} }) };
    const text = await runner.run({ sessionId: "team:r:s:1", bot: bots[1], prompt: "p", permissionMode: "ask", scope, tools: [verdict] }, observer, new AbortController().signal);
    expect(text).toBe("检查中\n\n磁盘正常");
    expect(seen).toEqual(["delta:检查中", "start:server_exec", "approval:ap1:df -h", "approval:none:", "target:server:a", "end:server_exec:done", "delta:\n\n磁盘正常"]);
    expect(runner.observe({ type: "message.delta", sessionId: "chat-1" })).toBe(false);
  });
});
