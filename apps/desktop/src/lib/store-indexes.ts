import type { RunInfo, SessionInfo, SubagentRunInfo } from "@qone/protocol";
import type { ChatMessage, ToolCall } from "../store";

const messageMaps = new WeakMap<readonly ChatMessage[], ReadonlyMap<string, ChatMessage>>();
const toolCallMaps = new WeakMap<readonly ToolCall[], ReadonlyMap<string, ToolCall>>();
const sessionMaps = new WeakMap<readonly SessionInfo[], ReadonlyMap<string, SessionInfo>>();
const runMaps = new WeakMap<readonly RunInfo[], ReadonlyMap<string, RunInfo>>();
const subagentMaps = new WeakMap<readonly SubagentRunInfo[], ReadonlyMap<string, SubagentRunInfo>>();
const subagentToolMaps = new WeakMap<readonly SubagentRunInfo[], ReadonlyMap<string, SubagentRunInfo>>();
const subagentIdLists = new WeakMap<readonly SubagentRunInfo[], readonly string[]>();
const subagentGroups = new WeakMap<readonly SubagentRunInfo[], ReadonlyMap<string, readonly SubagentRunInfo[]>>();
const subagentTrees = new WeakMap<readonly SubagentRunInfo[], Map<string, readonly SubagentRunInfo[]>>();
const EMPTY_SUBAGENTS: readonly SubagentRunInfo[] = [];
let previousSubagentGroups: ReadonlyMap<string, readonly SubagentRunInfo[]> | undefined;

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

export function subagentIds(subagents: readonly SubagentRunInfo[]) {
  let ids = subagentIdLists.get(subagents);
  if (!ids) {
    ids = subagents.map((item) => item.id);
    subagentIdLists.set(subagents, ids);
  }
  return ids;
}

export function subagentsForParent(subagents: readonly SubagentRunInfo[], parentRunId: string | undefined): readonly SubagentRunInfo[] {
  if (!parentRunId) return EMPTY_SUBAGENTS;
  let groups = subagentGroups.get(subagents);
  if (!groups) {
    const next = new Map<string, readonly SubagentRunInfo[]>();
    for (const item of subagents) next.set(item.parentRunId, [...(next.get(item.parentRunId) ?? []), item]);
    if (previousSubagentGroups) {
      for (const [id, items] of next) {
        const previous = previousSubagentGroups.get(id);
        if (previous && previous.length === items.length && items.every((item, index) => item === previous[index])) next.set(id, previous);
      }
    }
    groups = next;
    previousSubagentGroups = groups;
    subagentGroups.set(subagents, groups);
  }
  return groups.get(parentRunId) ?? EMPTY_SUBAGENTS;
}

export function subagentsForTree(subagents: readonly SubagentRunInfo[], rootRunId: string | undefined): readonly SubagentRunInfo[] {
  if (!rootRunId) return EMPTY_SUBAGENTS;
  let trees = subagentTrees.get(subagents);
  if (!trees) {
    const groups = new Map<string, SubagentRunInfo[]>();
    for (const item of subagents) groups.set(item.parentRunId, [...(groups.get(item.parentRunId) ?? []), item]);
    const next = new Map<string, SubagentRunInfo[]>();
    trees = next;
    subagentTrees.set(subagents, trees);
  }
  if (!trees.has(rootRunId)) {
    const result: SubagentRunInfo[] = [];
    const queue = [...subagentsForParent(subagents, rootRunId)];
    while (queue.length) {
      const item = queue.shift()!;
      result.push(item);
      queue.push(...subagentsForParent(subagents, item.id));
    }
    trees.set(rootRunId, result);
  }
  return trees.get(rootRunId) ?? EMPTY_SUBAGENTS;
}
