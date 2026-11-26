import { normalizeTeamExecution, serverOperationInfo, type ServerInfo, type TeamExecutionConfig, type TeamExecutionStrategy, type TeamRunStep, type TeamStepTarget } from "@qone/protocol";
import { decide, permissionNames } from "../permissions.js";

/** 一次成员回合实际可用的执行环境，由群配置与服务器注册表实时推导。 */
export interface TeamExecutionScope {
  /** 本机工作目录：群绑定项目 → 本次发送时的活跃项目 → 运行时目录。 */
  cwd: string;
  strategy: TeamExecutionStrategy;
  /** 挂载远端工具的已绑定服务器（仅保留仍存在于注册表中的）。 */
  servers: ServerInfo[];
  /** 是否允许本机写文件与执行命令。 */
  localWrite: boolean;
  /** 规划/统筹/汇总回合只读：只放行权限策略判定为免审批的读取类工具。 */
  readOnly: boolean;
  /** 统筹规划回合且群内存在可分派成员：强制由统筹通过 team_plan 分工，禁止越权亲自执行或探测。 */
  planningDelegation?: boolean;
}

/** 本机内置工具；其余工具若带服务器操作信息则归属对应服务器。 */
const LOCAL_TOOLS = new Set(["read", "write", "edit", "powershell", "bash", "grep", "find", "ls"]);
const LOCAL_MUTATIONS = new Set(["shell.execute", "filesystem.write"]);

export function resolveExecutionScope(
  execution: TeamExecutionConfig,
  registry: readonly ServerInfo[],
  cwd: string,
  readOnly: boolean,
  planningDelegation = false,
): TeamExecutionScope {
  const config = normalizeTeamExecution(execution);
  const servers = config.strategy === "local-only" ? [] : config.serverIds
    .map((id) => registry.find((server) => server.id === id))
    .filter((server): server is ServerInfo => Boolean(server));
  // 绑定的服务器都已删除时退回本机，避免出现既无本机也无服务器的空环境。
  return {
    cwd,
    strategy: config.strategy,
    servers,
    localWrite: servers.length === 0 || config.allowLocal,
    readOnly,
    ...(planningDelegation ? { planningDelegation: true } : {}),
  };
}

/** 执行前的预期环境；执行后由真实工具结果覆盖。 */
export function expectedTarget(scope: TeamExecutionScope): Pick<TeamRunStep, "targetKind" | "targetId" | "targetLabel"> {
  if (!scope.servers.length) return { targetKind: "local" };
  const only = scope.servers.length === 1 && !scope.localWrite ? scope.servers[0] : undefined;
  return only ? { targetKind: "server", targetId: only.id, targetLabel: only.name } : { targetKind: "auto" };
}

/** 隔离会话的工具闸门：返回拒绝原因时工具不会执行，也不会弹出审批。 */
export function teamToolDenial(scope: TeamExecutionScope, toolName: string, args: unknown): string | undefined {
  if (scope.planningDelegation) {
    return `Tool ${toolName} is not allowed during coordinator planning while group members are available. Call team_plan immediately to assign this investigation, command, or operational work to the matching member(s); they run with the group's full execution permissions.`;
  }
  if (scope.readOnly && decide({ toolName, args, workspacePath: scope.cwd }) !== "allow") {
    return `Tool ${toolName} is blocked: this turn is read-only (planning, coordination or summary). Delegate server inspection, shell commands, or operational/code work to group members via team_plan instead of retrying or searching unrelated tools.`;
  }
  if (!scope.localWrite && permissionNames(toolName).some((permission) => LOCAL_MUTATIONS.has(permission))) {
    return `Tool ${toolName} is blocked: this group does not allow writing files or running commands on this computer. Use one of the bound servers.`;
  }
  return undefined;
}

/** 只依据运行时产生的结果判定环境，不读取模型参数里的服务器名。 */
export function observedTarget(toolName: string, result: unknown): TeamStepTarget | undefined {
  const details = (result as { details?: { denied?: unknown; rejected?: unknown; cancelled?: unknown } } | undefined)?.details;
  if (details?.denied || details?.rejected || details?.cancelled) return undefined;
  const operation = serverOperationInfo(result);
  if (operation) return { kind: "server", id: operation.serverId, label: operation.serverName };
  return LOCAL_TOOLS.has(toolName) ? { kind: "local" } : undefined;
}

/** 记录一次真实使用的环境：去重累积，最近一次作为卡片主标签。 */
export function withObservedTarget<T extends TeamRunStep>(step: T, target: TeamStepTarget): T {
  const same = (item: TeamStepTarget) => item.kind === target.kind && item.id === target.id;
  const targets = [...(step.targets ?? []).filter((item) => !same(item)), target];
  return { ...step, targets, targetKind: target.kind, targetId: target.id, targetLabel: target.label };
}
