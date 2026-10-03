import { applyReasoningDelta, type AssistantMessagePart, type RuntimeEvent, type SubagentMessageInfo, type SubagentRunInfo, type SubagentRunPatch } from "@qone/protocol";
import { subagentById } from "./store-indexes";

function reconcile<T>(previous: T, incoming: T): T {
  if (Object.is(previous, incoming)) return previous;
  if (!previous || !incoming || typeof previous !== "object" || typeof incoming !== "object") return incoming;
  if (Array.isArray(previous) && Array.isArray(incoming)) {
    const items = incoming.map((item, index) => reconcile(previous[index], item));
    return (previous.length === items.length && items.every((item, index) => item === previous[index]) ? previous : items) as T;
  }
  if (Array.isArray(previous) || Array.isArray(incoming)) return incoming;
  const before = previous as Record<string, unknown>, after = incoming as Record<string, unknown>;
  const result: Record<string, unknown> = {};
  const keys = Object.keys(after);
  for (const key of keys) result[key] = reconcile(before[key], after[key]);
  return (keys.length === Object.keys(before).length && keys.every((key) => Object.hasOwn(before, key) && before[key] === result[key]) ? previous : result) as T;
}

function mergeMessages(previous: SubagentMessageInfo[] | undefined, incoming: SubagentMessageInfo[] | undefined) {
  if (!incoming?.length) return previous;
  const messages = previous ?? [];
  const positions = new Map(messages.map((message, index) => [message.id, index]));
  let next: SubagentMessageInfo[] | undefined;
  for (const message of incoming) {
    const index = positions.get(message.id);
    if (index === undefined) {
      next ??= [...messages];
      positions.set(message.id, next.length);
      next.push(message);
    } else {
      const saved = (next ?? messages)[index]!;
      const updated = reconcile(saved, message);
      if (updated !== saved) {
        next ??= [...messages];
        next[index] = updated;
      }
    }
  }
  return next ?? previous;
}

type ToolLocation = { messageIndex: number; partIndex: number };
const savedToolLocations = new WeakMap<SubagentMessageInfo[], ReadonlyMap<string, ToolLocation[]>>();

function syncSavedTools(messages: SubagentMessageInfo[] | undefined, changed: readonly AssistantMessagePart[]) {
  if (!messages?.length || !changed.some((part) => part.type === "tool-call")) return messages;
  let locations = savedToolLocations.get(messages);
  if (!locations) {
    const next = new Map<string, ToolLocation[]>();
    messages.forEach((message, messageIndex) => message.parts?.forEach((part, partIndex) => {
      if (part.type !== "tool-call") return;
      let entries = next.get(part.toolCallId);
      if (!entries) next.set(part.toolCallId, entries = []);
      entries.push({ messageIndex, partIndex });
    }));
    locations = next;
    savedToolLocations.set(messages, next);
  }
  let next: SubagentMessageInfo[] | undefined;
  for (const part of changed) {
    if (part.type !== "tool-call") continue;
    for (const { messageIndex, partIndex } of locations.get(part.toolCallId) ?? []) {
      const message = (next ?? messages)[messageIndex]!;
      const updated = reconcile(message.parts![partIndex]!, part);
      if (updated === message.parts![partIndex]) continue;
      next ??= [...messages];
      const parts = [...message.parts!];
      parts[partIndex] = updated;
      next[messageIndex] = { ...message, parts };
    }
  }
  if (next) savedToolLocations.set(next, locations);
  return next ?? messages;
}

export function applySubagentPatch(current: SubagentRunInfo, patch: SubagentRunPatch): SubagentRunInfo {
  if (patch.id !== current.id || isStale(current, patch)) return current;
  const { messagesAppend, partsPatch, partsChanges, streaming, ...fields } = patch;
  if (partsPatch && (!Number.isInteger(partsPatch.start) || partsPatch.start < 0 || partsPatch.start > current.parts.length)) return current;
  if (partsChanges && (!Number.isInteger(partsChanges.length) || partsChanges.length < 0
    || partsChanges.updates.some(({ index }) => !Number.isInteger(index) || index < 0 || index >= partsChanges.length))) return current;
  let parts = partsPatch ? reconcile(current.parts, [...current.parts.slice(0, partsPatch.start), ...partsPatch.parts]) : current.parts;
  if (partsChanges) {
    const updated = parts.slice(0, partsChanges.length);
    for (const { index, part } of partsChanges.updates) updated[index] = reconcile(parts[index], part);
    if (updated.length !== partsChanges.length || Array.from({ length: updated.length }, (_, index) => updated[index]).some((part) => !part)) return current;
    parts = reconcile(parts, updated);
  }
  const messages = syncSavedTools(mergeMessages(current.messages, messagesAppend), [...(partsPatch?.parts ?? []), ...(partsChanges?.updates.map(({ part }) => part) ?? [])]);
  const next = { ...current, ...fields, parts, ...(messages ? { messages } : {}),
    ...(streaming !== undefined ? { streaming: streaming === null ? undefined : streaming } : {}) };
  return Object.keys(next).every((key) => next[key as keyof SubagentRunInfo] === current[key as keyof SubagentRunInfo]) ? current : next;
}

export function applySubagentStreaming(current: SubagentRunInfo, event: Extract<RuntimeEvent, { type: "subagent.streaming" }>) {
  if (event.id !== current.id || event.sessionId !== current.parentSessionId || isStale(current, event) || (!event.delta && !event.reasoning?.length)
    || !["created", "running", "waiting_approval", "paused"].includes(current.status)) return current;
  let parts = current.parts;
  for (const value of event.reasoning ?? []) parts = applyReasoningDelta(parts, value, value.messageSequence);
  return { ...current, parts, streaming: event.delta ? (current.streaming ?? "") + event.delta : current.streaming,
    ...(event.revision !== undefined ? { revision: event.revision, revisionEpoch: event.revisionEpoch } : {}) };
}

function isStale(current: SubagentRunInfo, incoming: { revision?: number; revisionEpoch?: string }) {
  return incoming.revisionEpoch === current.revisionEpoch && incoming.revision !== undefined
    && current.revision !== undefined && incoming.revision <= current.revision;
}

export function updateSubagent(items: SubagentRunInfo[], id: string, update: (item: SubagentRunInfo) => SubagentRunInfo) {
  const current = subagentById(items, id);
  if (!current) return items;
  const next = update(current);
  if (current === next) return items;
  return items.map((item) => item.id === id ? next : item);
}

export function mergeSubagentSnapshots(items: SubagentRunInfo[], incoming: readonly SubagentRunInfo[]) {
  const updates = new Map<string, SubagentRunInfo>();
  let needsSort = false;
  for (const snapshot of incoming) {
    const current = updates.get(snapshot.id) ?? subagentById(items, snapshot.id);
    if (current && isStale(current, snapshot)) continue;
    const updated = current ? reconcile(current, snapshot) : snapshot;
    if (current === updated) continue;
    updates.set(snapshot.id, updated);
    needsSort ||= !current || current.startedAt !== updated.startedAt;
  }
  if (!updates.size) return items;
  const next = items.map((item) => { const updated = updates.get(item.id) ?? item; updates.delete(item.id); return updated; });
  next.push(...updates.values());
  return needsSort ? [...next].sort((a, b) => a.startedAt - b.startedAt) : next;
}
