import type { RunInfo, SessionInfo, SubagentRunInfo } from "@qone/protocol";
import type { ChatMessage, ToolCall } from "../store";

const messageMaps = new WeakMap<readonly ChatMessage[], ReadonlyMap<string, ChatMessage>>();
const toolCallMaps = new WeakMap<readonly ToolCall[], ReadonlyMap<string, ToolCall>>();
const sessionMaps = new WeakMap<readonly SessionInfo[], ReadonlyMap<string, SessionInfo>>();
const runMaps = new WeakMap<readonly RunInfo[], ReadonlyMap<string, RunInfo>>();
const subagentMaps = new WeakMap<readonly SubagentRunInfo[], ReadonlyMap<string, SubagentRunInfo>>();
const subagentToolMaps = new WeakMap<readonly SubagentRunInfo[], ReadonlyMap<string, SubagentRunInfo>>();
const subagentGroups = new WeakMap<readonly SubagentRunInfo[], ReadonlyMap<string, readonly SubagentRunInfo[]>>();
const subagentTrees = new WeakMap<readonly SubagentRunInfo[], Map<string, readonly SubagentRunInfo[]>>();
const EMPTY_SUBAGENTS: readonly SubagentRunInfo[] = [];
const toolGroups = new WeakMap<readonly ToolCall[], ReadonlyMap<string | undefined, ToolCall[]>>();
const messageGroups = new WeakMap<readonly ChatMessage[], ReadonlyMap<string | undefined, ChatMessage[]>>();

function groupByRun<T extends { runId?: string }>(items: readonly T[], cache: WeakMap<readonly T[], ReadonlyMap<string | undefined, T[]>>) {
  let groups = cache.get(items);
  if (!groups) {
    const next = new Map<string | undefined, T[]>();
    for (const item of items) {
      let group = next.get(item.runId);
      if (!group) next.set(item.runId, group = []);
      group.push(item);
    }
    cache.set(items, groups = next);
  }
  return groups;
}

function stableArraySelector<T>() {
  let previous: readonly T[] = [];
  return (next: readonly T[]) => {
    if (previous.length !== next.length || next.some((item, index) => item !== previous[index])) previous = next;
    return previous;
  };
}

export function createRunMessagesSelector() {
  const stable = stableArraySelector<ChatMessage>();
  return (messages: readonly ChatMessage[], runId?: string) => stable(runId ? groupByRun(messages, messageGroups).get(runId) ?? [] : []);
}

export function createRunToolsSelector() {
  const stable = stableArraySelector<ToolCall>();
  return (calls: readonly ToolCall[], runId?: string) => stable(runId ? groupByRun(calls, toolGroups).get(runId) ?? [] : []);
}

export function createPartToolsSelector() {
  const stable = stableArraySelector<ToolCall>();
  return (calls: readonly ToolCall[], parts: readonly { type: string; toolCallId?: string }[]) => stable(parts.flatMap((part) => {
    const call = part.type === "tool-call" && part.toolCallId ? toolCallById(calls, part.toolCallId) : undefined;
    return call ? [call] : [];
  }));
}

function mapFor<T extends { id: string }>(items: readonly T[], cache: WeakMap<readonly T[], ReadonlyMap<string, T>>) {
  let result = cache.get(items);
  if (!result) {
    result = new Map(items.map((item) => [item.id, item]));
    cache.set(items, result);
  }
  return result;
}

export function messageById(messages: readonly ChatMessage[], id: string) {
  return mapFor(messages, messageMaps).get(id);
}

export function toolCallById(toolCalls: readonly ToolCall[], id: string) {
  let result = toolCallMaps.get(toolCalls);
  if (!result) {
    result = new Map(toolCalls.map((item) => [item.toolCallId, item]));
    toolCallMaps.set(toolCalls, result);
  }
  return result.get(id);
}

export function sessionById(sessions: readonly SessionInfo[], id: string) {
  return mapFor(sessions, sessionMaps).get(id);
}

export function runById(runs: readonly RunInfo[], id: string | undefined) {
  if (!id) return undefined;
  return mapFor(runs, runMaps).get(id);
}

export function subagentById(subagents: readonly SubagentRunInfo[], id: string | undefined) {
  if (!id) return undefined;
  return mapFor(subagents, subagentMaps).get(id);
}

export function subagentByParentTool(subagents: readonly SubagentRunInfo[], parentRunId: string | undefined, toolCallId: string) {
  if (!parentRunId) return undefined;
  let map = subagentToolMaps.get(subagents);
  if (!map) {
    map = new Map(subagents.map((item) => [`${item.parentRunId}\u0000${item.toolCallId}`, item]));
    subagentToolMaps.set(subagents, map);
  }
  return map.get(`${parentRunId}\u0000${toolCallId}`);
}

export function createSubagentIdsSelector() {
  let previous: readonly string[] = [];
  return (subagents: readonly SubagentRunInfo[]) => {
    if (previous.length !== subagents.length || subagents.some((item, index) => item.id !== previous[index])) {
      previous = subagents.map((item) => item.id);
    }
    return previous;
  };
}

export type SubagentSummary = Pick<SubagentRunInfo, "id" | "title" | "profileId" | "status" | "startedAt" | "completedAt">;

export function createSubagentSummarySelector() {
  let previous: SubagentSummary | undefined;
  return (subagents: readonly SubagentRunInfo[], id: string) => {
    const item = subagentById(subagents, id);
    if (!item) return previous = undefined;
    if (previous?.id === item.id && previous.title === item.title && previous.profileId === item.profileId
      && previous.status === item.status && previous.startedAt === item.startedAt && previous.completedAt === item.completedAt) return previous;
    return previous = { id: item.id, title: item.title, profileId: item.profileId, status: item.status, startedAt: item.startedAt, completedAt: item.completedAt };
  };
}

export function subagentsForParent(subagents: readonly SubagentRunInfo[], parentRunId: string | undefined): readonly SubagentRunInfo[] {
  if (!parentRunId) return EMPTY_SUBAGENTS;
  let groups = subagentGroups.get(subagents);
  if (!groups) {
    const grouped = new Map<string, SubagentRunInfo[]>();
    for (const item of subagents) {
      let group = grouped.get(item.parentRunId);
      if (!group) grouped.set(item.parentRunId, group = []);
      group.push(item);
    }
    const next = new Map<string, readonly SubagentRunInfo[]>(grouped);
    groups = next;
    subagentGroups.set(subagents, groups);
  }
  return groups.get(parentRunId) ?? EMPTY_SUBAGENTS;
}

export function subagentsForTree(subagents: readonly SubagentRunInfo[], rootRunId: string | undefined): readonly SubagentRunInfo[] {
  if (!rootRunId) return EMPTY_SUBAGENTS;
  let trees = subagentTrees.get(subagents);
  if (!trees) {
    const next = new Map<string, SubagentRunInfo[]>();
    trees = next;
    subagentTrees.set(subagents, trees);
  }
  if (!trees.has(rootRunId)) {
    const result: SubagentRunInfo[] = [];
    const queue = [...subagentsForParent(subagents, rootRunId)];
    const visited = new Set<string>();
    for (let index = 0; index < queue.length; index++) {
      const item = queue[index]!;
      if (visited.has(item.id)) continue;
      visited.add(item.id);
      result.push(item);
      queue.push(...subagentsForParent(subagents, item.id));
    }
    trees.set(rootRunId, result);
  }
  return trees.get(rootRunId) ?? EMPTY_SUBAGENTS;
}
