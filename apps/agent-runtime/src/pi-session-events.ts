import { ModelResponseTiming } from "./model-response-timing.js";
import { extractTextContent } from "./pi-message-utils.js";
import { createLogger } from "@qone/shared";

const log = createLogger("pi-adapter");

export interface SessionSubscriptionHooks {
  onMessage?: (sessionId: string, runId: string, role: "assistant" | "tool", content: string) => void;
  onAssistantFinal?: (sessionId: string, runId: string, content: string) => void;
  onTool?: (sessionId: string, runId: string, phase: "start" | "end", name: string, args?: unknown, result?: unknown, toolCallId?: string, parentToolCallId?: string, durationMs?: number) => void;
  onCustomEntry?: (sessionId: string, entry: unknown) => void;
}

export interface SessionSubscriptionContext {
  sessionId: string;
  eventSessionId: string;
  session: unknown;
  runs: Map<string, unknown>;
  activeRunIds: Map<string, string>;
  toolNameByModelName: Map<string, string>;
  hooks: SessionSubscriptionHooks;
  push(type: string, payload: unknown, sessionId: string, runId?: string): void;
}

/**
 * Translates Pi session events into product protocol events and hook calls.
 * Extracted from PiAdapter.getSession so the adapter stays readable; the
 * context carries exactly the adapter state this loop reads.
 */
export function subscribeSessionEvents(ctx: SessionSubscriptionContext): void {
  const { sessionId, eventSessionId, session, runs, activeRunIds, toolNameByModelName, hooks, push } = ctx;
  let lastToolDeltaAt = 0;
  const responseTiming = new ModelResponseTiming();
  type PiSessionEvent = { type: string; [key: string]: any };
  (session as { subscribe(listener: (e: PiSessionEvent) => void): void }).subscribe((e) => {
    const candidateRunId = activeRunIds.get(sessionId);
    const runId = candidateRunId && runs.get(candidateRunId) === session ? candidateRunId : undefined;
    const raw = e as unknown as Record<string, unknown>;
    const messageEvent = raw.assistantMessageEvent as { type?: string; delta?: string; contentIndex?: number; toolCall?: unknown } | undefined;
    const normalized = messageEvent?.delta
      ? { ...raw, delta: messageEvent.delta }
      : raw;
    let protocolType: string = e.type;
    let protocolPayload = normalized;
    if (e.type === "message_start") {
      lastToolDeltaAt = 0;
      protocolType = "message.started";
    }
    else if (e.type === "message_update") {
      const content = (raw.message as { content?: unknown } | undefined)?.content;
      const block = Array.isArray(content) && typeof messageEvent?.contentIndex === "number"
        ? content[messageEvent.contentIndex] as { id?: string; name?: string; arguments?: unknown } | undefined
        : undefined;
      if (messageEvent?.type === "thinking_delta") {
        protocolType = "message.reasoning.delta";
        protocolPayload = { delta: messageEvent.delta ?? "", contentIndex: messageEvent.contentIndex };
      } else if (messageEvent?.type === "text_delta") {
        protocolType = "message.delta";
        protocolPayload = { delta: messageEvent.delta ?? "", contentIndex: messageEvent.contentIndex };
      } else if (messageEvent?.type === "thinking_start" || messageEvent?.type === "text_start" || messageEvent?.type === "toolcall_start") {
        protocolType = "message.block.started";
        protocolPayload = messageEvent.type !== "toolcall_start"
          ? { blockType: messageEvent.type === "thinking_start" ? "reasoning" : "text", contentIndex: messageEvent.contentIndex }
          : {
              blockType: "tool-call", contentIndex: messageEvent.contentIndex,
              toolCallId: block?.id,
              toolName: toolNameByModelName.get(String(block?.name ?? "")) ?? block?.name,
              args: block?.arguments,
            };
      } else if (messageEvent?.type === "toolcall_delta") {
        // Pi has already parsed the partial JSON. Send snapshots at ~30fps;
        // block.completed always delivers the final arguments without throttling.
        const now = Date.now();
        if (now - lastToolDeltaAt < 32) return;
        lastToolDeltaAt = now;
        protocolType = "message.delta";
        protocolPayload = {
          blockType: "tool-call", contentIndex: messageEvent.contentIndex,
          toolCallId: block?.id,
          toolName: toolNameByModelName.get(String(block?.name ?? "")) ?? block?.name,
          args: block?.arguments,
        };
      } else if (messageEvent?.type === "thinking_end") {
        protocolType = "message.block.completed";
        protocolPayload = { blockType: "reasoning", contentIndex: messageEvent.contentIndex };
      } else if (messageEvent?.type === "toolcall_end") {
        const toolCall = messageEvent.toolCall as { id?: string; name?: string; arguments?: unknown } | undefined ?? block;
        protocolType = "message.block.completed";
        protocolPayload = {
          blockType: "tool-call", contentIndex: messageEvent.contentIndex,
          toolCallId: toolCall?.id,
          toolName: toolNameByModelName.get(String(toolCall?.name ?? "")) ?? toolCall?.name,
          args: toolCall?.arguments,
        };
      } else return;
    } else if (e.type === "message_end") protocolType = "message.completed";
    else if (e.type === "turn_start") protocolType = "model.request.started";
    else if (e.type === "tool_execution_start") {
      protocolType = "tool.started";
      protocolPayload = { toolCallId: raw.toolCallId, parentToolCallId: raw.parentToolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, args: raw.args ?? raw.input };
    } else if (e.type === "tool_execution_update") {
      protocolType = "tool.updated";
      protocolPayload = { toolCallId: raw.toolCallId, parentToolCallId: raw.parentToolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, update: raw.partialResult ?? raw.update };
    } else if (e.type === "tool_execution_end") {
      const result = raw.result as { isError?: boolean } | undefined;
      const isError = e.isError || result?.isError === true;
      protocolType = isError ? "tool.failed" : "tool.completed";
      protocolPayload = { toolCallId: raw.toolCallId, parentToolCallId: raw.parentToolCallId, toolName: toolNameByModelName.get(String(raw.toolName ?? "")) ?? raw.toolName, result: isError ? { ...result, isError: true } : raw.result, isError, durationMs: e.durationMs };
    } else if (e.type === "agent_start") protocolType = "turn.started";
    else if (e.type === "agent_end") protocolType = "turn.completed";
    else if (e.type === "entry_appended") {
      protocolType = "session.entry.appended";
      protocolPayload = { entry: raw.entry };
      hooks.onCustomEntry?.(eventSessionId, raw.entry);
    }
    push(protocolType, protocolPayload, eventSessionId, runId);
    const timing = responseTiming.record(protocolType, protocolPayload);
    if (timing) {
      push("model.response.timing", timing, eventSessionId, runId);
      log.info("model response timing", { sessionId: eventSessionId, runId, ...timing });
    }
    if (!runId) return;
    const p = normalized as { type?: string; assistantMessageEvent?: { type?: string; delta?: string }; message?: unknown; toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
    const toolPayload = protocolPayload as { toolName?: string; toolCallId?: string; args?: unknown; result?: unknown };
    const delta = p.assistantMessageEvent?.delta;
    if (p.assistantMessageEvent?.type === "text_delta" && typeof delta === "string" && delta) hooks.onMessage?.(eventSessionId, runId, "assistant", delta);
    if (e.type === "message_end" && e.message.role === "assistant" && e.message.stopReason !== "error" && e.message.stopReason !== "aborted") {
      const finalText = extractTextContent(raw.message);
      if (finalText) hooks.onAssistantFinal?.(eventSessionId, runId, finalText);
    }
    if (e.type === "tool_execution_start") {
      const name = toolNameByModelName.get(String(toolPayload.toolName ?? "")) ?? String(toolPayload.toolName ?? "tool");
      hooks.onTool?.(eventSessionId, runId, "start", name, toolPayload.args, undefined, toolPayload.toolCallId, String((toolPayload as { parentToolCallId?: unknown }).parentToolCallId ?? "") || undefined);
    }
    if (e.type === "tool_execution_end") {
      const name = toolNameByModelName.get(String(toolPayload.toolName ?? "")) ?? String(toolPayload.toolName ?? "tool");
      hooks.onTool?.(eventSessionId, runId, "end", name, toolPayload.args, toolPayload.result, toolPayload.toolCallId, String((toolPayload as { parentToolCallId?: unknown }).parentToolCallId ?? "") || undefined, typeof e.durationMs === "number" ? e.durationMs : undefined);
    }
  });
}