import type { AssistantMessagePart } from "@qone/protocol";
import type { ChatMessage, ToolCall } from "../store";

type ToolPart = Extract<AssistantMessagePart, { type: "tool-call" }>;

export function alignToolCallIds(calls: readonly ToolCall[], messages: readonly ChatMessage[]): ToolCall[] {
  if (!calls.length) return calls as ToolCall[];
  const exactByRun = new Map<string, Map<string, ToolPart>>();
  const byNameByRun = new Map<string, Map<string, ToolPart[]>>();
  for (const message of messages) {
    if (!message.runId || !message.parts) continue;
    for (const part of message.parts) {
      if (part.type !== "tool-call") continue;
      const exact = exactByRun.get(message.runId) ?? new Map<string, ToolPart>();
      const byName = byNameByRun.get(message.runId) ?? new Map<string, ToolPart[]>();
      if (!exact.has(part.toolCallId)) exact.set(part.toolCallId, part);
      const sameName = byName.get(part.toolName);
      if (sameName) sameName.push(part);
      else byName.set(part.toolName, [part]);
      exactByRun.set(message.runId, exact);
      byNameByRun.set(message.runId, byName);
    }
  }
  if (!exactByRun.size) return calls as ToolCall[];
  const used = new Map<string, Set<string>>();
  const cursors = new Map<ToolPart[], number>();
  let changed = false;
  const aligned = calls.map((call) => {
    const runUsed = used.get(call.runId) ?? new Set<string>();
    let match = exactByRun.get(call.runId)?.get(call.toolCallId);
    if (!match) {
      const candidates = byNameByRun.get(call.runId)?.get(call.toolName);
      if (candidates) {
        let cursor = cursors.get(candidates) ?? 0;
        while (cursor < candidates.length && runUsed.has(candidates[cursor]!.toolCallId)) cursor++;
        match = candidates[cursor];
        cursors.set(candidates, cursor + 1);
      }
    }
    if (!match) return call;
    runUsed.add(match.toolCallId);
    used.set(call.runId, runUsed);
    if (match.toolCallId === call.toolCallId) return call;
    changed = true;
    return { ...call, toolCallId: match.toolCallId };
  });
  return changed ? aligned : calls as ToolCall[];
}
