import { serverOperationInfo, type ServerInfo, type ServerOperationInfo, type SubagentRunInfo } from "@qone/protocol";
import type { ToolCall } from "../store";
import { subagentById, toolCallById } from "./store-indexes";

export const UNRESOLVED_SERVER = "";
export const isServerOperation = (call: ToolCall) => call.toolName.startsWith("server_");
export const operationTarget = (call: ToolCall | undefined): ServerOperationInfo | undefined => call?.serverOperation ?? serverOperationInfo(call?.result);
export const operationActive = (call: ToolCall) => call.status === "running" || call.status === "waiting";

function stable<T>(previous: readonly T[], next: readonly T[]): readonly T[] {
  return previous.length === next.length && previous.every((value, index) => value === next[index]) ? previous : next;
}

const groups = new WeakMap<readonly ToolCall[], Map<string, ToolCall[]>>();
export function serverOperationGroups(calls: readonly ToolCall[]) {
  let value = groups.get(calls);
  if (!value) {
    value = new Map();
    for (const call of calls) {
      if (!isServerOperation(call)) continue;
      const id = operationTarget(call)?.serverId ?? UNRESOLVED_SERVER;
      const group = value.get(id) ?? [];
      group.push(call);
      value.set(id, group);
    }
    groups.set(calls, value);
  }
  return value;
}

export function operationRootRun(call: ToolCall, subagents: readonly SubagentRunInfo[]): string {
  let id = call.runId;
  const visited = new Set<string>();
  for (let child = subagentById(subagents, id); child && !visited.has(id); child = subagentById(subagents, id)) {
    visited.add(id); id = child.parentRunId;
  }
  return id;
}

const roundCaches = new WeakMap<readonly ToolCall[], WeakMap<readonly SubagentRunInfo[], Map<string, number>>>();
export function operationRound(calls: readonly ToolCall[], subagents: readonly SubagentRunInfo[], call: ToolCall): number {
  let cache = roundCaches.get(calls);
  if (!cache) roundCaches.set(calls, cache = new WeakMap());
  let rounds = cache.get(subagents);
  if (!rounds) {
    rounds = new Map();
    for (const item of calls) if (isServerOperation(item)) {
      const root = operationRootRun(item, subagents);
      if (!rounds.has(root)) rounds.set(root, rounds.size + 1);
    }
    cache.set(subagents, rounds);
  }
  return rounds.get(operationRootRun(call, subagents)) ?? 1;
}

export function createServerIdsSelector() {
  let previous: readonly string[] = [];
  return (calls: readonly ToolCall[], selected: readonly string[] = []) => previous = stable(previous, [...new Set([...selected, ...serverOperationGroups(calls).keys()])]);
}

export function createServerCallIdsSelector() {
  let previous: readonly string[] = [];
  return (calls: readonly ToolCall[], id: string) => previous = stable(previous, (serverOperationGroups(calls).get(id) ?? []).map(call => call.toolCallId));
}

export function createServerCallSummarySelector() {
  let previous: Omit<ToolCall, "result" | "summary" | "serverOperation"> | undefined;
  return (calls: readonly ToolCall[], id: string) => {
    const call = toolCallById(calls, id);
    if (!call) return previous = undefined;
    const { result: _, summary: __, serverOperation: ___, ...next } = call;
    if (previous && [...Object.keys(previous), ...Object.keys(next)].every(key => next[key as keyof typeof next] === previous![key as keyof typeof next])) return previous;
    return previous = next;
  };
}

export interface ServerSummary { id: string; name?: string; count: number; status?: ToolCall["status"] }
export function createServerSummarySelector() {
  let previous: ServerSummary | undefined;
  return (calls: readonly ToolCall[], servers: readonly ServerInfo[], id: string): ServerSummary => {
    const group = serverOperationGroups(calls).get(id) ?? [];
    const name = servers.find(server => server.id === id)?.name ?? operationTarget(group.at(-1)!)?.serverName;
    const status = group.some(call => call.status === "running") ? "running" : group.some(call => call.status === "waiting") ? "waiting" : group.at(-1)?.status;
    if (previous?.id === id && previous.name === name && previous.count === group.length && previous.status === status) return previous;
    return previous = { id, name, count: group.length, status };
  };
}
