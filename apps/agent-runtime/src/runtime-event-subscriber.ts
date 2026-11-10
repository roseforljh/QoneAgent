import type { AgentEvent, AssistantMessagePart, SubagentConfigInfo } from "@qone/protocol";
import { applyAssistantToolEvent, applyReasoningDelta, assistantPartsFromPiMessage } from "@qone/protocol";
import type { MessageRepo, RunRepo, SettingsRepo, SubagentRunRepo, ToolCallRepo } from "@qone/database";
import { isAssistantMessageActivity } from "./session-activity.js";
import { updateLiveAssistant, type LiveAssistantState } from "./live-assistant.js";
import type { CompactionPositions } from "./compaction-position.js";
import { finalSubagentSummary } from "./subagent-result.js";
import { isSubagentUpdatePrompt } from "./subagent-notifications.js";
import type { SubagentNotificationCoordinator } from "./subagent-notifications.js";
import type { registerSubagentDispatcher } from "./subagent-runner.js";
import type { createSubagentPublisher } from "./subagent-publisher.js";

export interface RuntimeBusEvent {
  type: string;
  payload: unknown;
  sessionId?: string;
  runId?: string;
  scope?: "conversation" | "subagent";
}

type SubagentPublisher = ReturnType<typeof createSubagentPublisher>;
type LiveAssistantUpdater = typeof updateLiveAssistant;

/**
 * Everything the bus subscriber reads or writes. Collections are passed by
 * reference on purpose: the subscriber mutates them in place, exactly as it did
 * while it lived inline in index.ts.
 */
export interface RuntimeEventContext {
  messageRepo: MessageRepo;
  runRepo: RunRepo;
  subagentRunRepo: SubagentRunRepo;
  toolCallRepo: ToolCallRepo;
  settingsRepo: SettingsRepo;

  assistantBuffers: Map<string, string>;
  assistantStreamBuffers: Map<string, string[]>;
  assistantPartsByRun: Map<string, AssistantMessagePart[]>;
  assistantRawMessagesByRun: Map<string, unknown[]>;
  assistantMessageSequenceByRun: Map<string, number>;
  liveAssistantByRun: Map<string, LiveAssistantState>;
  subagentStreams: Map<string, string[]>;
  activeSubagents: Set<string>;
  subagentRunIds: Set<string>;
  initialUserMessageSeen: Set<string>;
  approvalRuns: Map<string, string>;
  approvalToolCalls: Map<string, string>;
  toolCallIds: Map<string, string>;
  compactionPositions: CompactionPositions;

  send(event: AgentEvent | { type: string; [key: string]: unknown }): void;
  emit(type: string, payload: unknown, sessionId?: string, runId?: string): void;
  flushEvents(): void;
  touchSession(sessionId: string, userMessageAt?: number): void;
  deliverSteer(sessionId: string, runId: string, rawUser?: unknown): void;
  queueEventPersistence(event: AgentEvent): void;
  runRequiresSubagentFinalization(sessionId: string, runId: string): boolean;

  subagentConfig(): SubagentConfigInfo;
  subagentController(): ReturnType<typeof registerSubagentDispatcher> | undefined;
  subagentNotificationCoordinator(): SubagentNotificationCoordinator | undefined;
  subagentPublisher: SubagentPublisher;
}

function readTokenUsage(value: unknown) {
  const usage = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const cost = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
  const input = Number(usage.input ?? usage.inputTokens ?? 0) || 0;
  const output = Number(usage.output ?? usage.outputTokens ?? 0) || 0;
  const cacheRead = Number(usage.cacheRead ?? usage.cacheReadTokens ?? 0) || 0;
  const cacheWrite = Number(usage.cacheWrite ?? usage.cacheWriteTokens ?? 0) || 0;
  const reportedTotal = Number(usage.total ?? usage.totalTokens ?? 0) || 0;
  return { input, output, cacheRead, cacheWrite, total: input + output + cacheRead + cacheWrite || reportedTotal, cost: Number(usage.totalCost ?? cost.total ?? usage.cost ?? 0) || 0 };
}

/** Records assistant/tool/reasoning parts for a run from the journal event. */
function applyRunParts(
  ctx: RuntimeEventContext,
  agentEvent: AgentEvent,
  parts: AssistantMessagePart[],
  childExecution: boolean,
  updateLive: LiveAssistantUpdater,
) {
  const runId = agentEvent.runId!;
  const live = ctx.liveAssistantByRun.get(runId);
  if (live) ctx.liveAssistantByRun.set(runId, updateLive(live, agentEvent));
  const completedMessageSequence = ctx.assistantMessageSequenceByRun.get(runId) ?? agentEvent.sequence;
  const messageRole = (agentEvent.payload as { message?: { role?: unknown } } | undefined)?.message?.role;
  if (agentEvent.type === "message.started" && messageRole === "assistant") {
    ctx.assistantMessageSequenceByRun.set(runId, agentEvent.sequence);
  } else if (agentEvent.type === "message.completed" && (messageRole === "assistant" || messageRole === "toolResult")) {
    const rawMessage = (agentEvent.payload as { message?: unknown }).message;
    if (rawMessage && typeof rawMessage === "object") {
      const raw = ctx.assistantRawMessagesByRun.get(runId) ?? [];
      raw.push(rawMessage);
      ctx.assistantRawMessagesByRun.set(runId, raw);
    }
    // Tool results belong to the same Pi turn as the assistant text; they
    // are restored from the raw transcript, not as product text parts.
    if (messageRole === "assistant") {
      const messageSequence = ctx.assistantMessageSequenceByRun.get(runId) ?? agentEvent.sequence;
      ctx.assistantPartsByRun.set(runId, [
        ...parts.filter((part) => part.messageSequence !== messageSequence),
        ...assistantPartsFromPiMessage(agentEvent.payload, messageSequence,
          ctx.runRequiresSubagentFinalization(agentEvent.sessionId ?? "", runId)
            && !ctx.runRepo.isFinalizationAuthorized(runId) ? "commentary" : undefined),
      ]);
      ctx.assistantMessageSequenceByRun.delete(runId);
    }
  } else if (agentEvent.type === "message.reasoning.delta") {
    ctx.assistantPartsByRun.set(runId, applyReasoningDelta(parts, agentEvent.payload, completedMessageSequence));
  } else if (agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "reasoning") {
    ctx.assistantPartsByRun.set(runId, applyReasoningDelta(parts, { ...(agentEvent.payload as object), complete: true }, completedMessageSequence));
  } else if (agentEvent.type === "tool.started" || agentEvent.type === "tool.completed" || agentEvent.type === "tool.failed") {
    ctx.assistantPartsByRun.set(runId, applyAssistantToolEvent(parts, agentEvent.type, agentEvent.payload));
  }
  if (childExecution && (agentEvent.type === "message.block.started"
    || (agentEvent.type === "message.delta" || agentEvent.type === "message.block.completed") && (agentEvent.payload as { blockType?: string }).blockType === "tool-call")) {
    const current = updateLive({ content: ctx.subagentStreams.get(runId)?.join("") ?? "", parts,
      messageSequence: ctx.assistantMessageSequenceByRun.get(runId), sequence: agentEvent.sequence }, agentEvent);
    ctx.assistantPartsByRun.set(runId, current.parts);
    if (current.content) ctx.subagentStreams.set(runId, [current.content]);
    else ctx.subagentStreams.delete(runId);
  }
}

/** Projects a child run's event onto its compact publish channel. */
function publishSubagentEvent(
  ctx: RuntimeEventContext,
  agentEvent: AgentEvent,
  completedMessageSequence: number,
  updateLive: LiveAssistantUpdater,
) {
  const runId = agentEvent.runId!;
  if (agentEvent.type === "message.completed" && (agentEvent.payload as { message?: { role?: string; usage?: unknown } }).message?.role === "assistant") {
    const usage = ctx.subagentRunRepo.updateUsage(runId, readTokenUsage((agentEvent.payload as { message?: { usage?: unknown } }).message?.usage));
    ctx.subagentPublisher.patch(runId, { tokenUsage: usage });
    const budget = ctx.subagentConfig().runtime.tokenBudget;
    if (budget > 0 && usage.total >= budget) {
      ctx.subagentController()?.fail(runId, "Subagent token budget exceeded");
      ctx.emit("subagent.budget_exceeded", { budget, usage }, agentEvent.sessionId, runId);
    }
  }
  if (agentEvent.type === "message.delta" && (agentEvent.payload as { blockType?: string }).blockType !== "tool-call" && typeof (agentEvent.payload as { delta?: unknown }).delta === "string") {
    const chunks = ctx.subagentStreams.get(runId);
    if (chunks) chunks.push((agentEvent.payload as { delta: string }).delta);
    else ctx.subagentStreams.set(runId, [(agentEvent.payload as { delta: string }).delta]);
  }
  if (agentEvent.type === "message.completed" && (agentEvent.payload as { message?: { role?: string } }).message?.role === "assistant") {
    ctx.subagentStreams.delete(runId);
  }
  const parts = ctx.assistantPartsByRun.get(runId) ?? [];
  if (["message.completed", "tool.completed", "tool.failed"].includes(agentEvent.type)) {
    ctx.subagentRunRepo.save(runId, ctx.assistantBuffers.get(runId) ?? "", parts);
  }
  ctx.subagentController()?.recordEvent(runId, agentEvent.type, agentEvent.payload, completedMessageSequence);
  if (agentEvent.type === "message.delta" && (agentEvent.payload as { blockType?: string }).blockType === "tool-call") {
    ctx.subagentPublisher.queueParts(runId, () => ctx.assistantPartsByRun.get(runId) ?? []);
  } else if (agentEvent.type === "message.block.started" || agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "tool-call") {
    ctx.subagentPublisher.patch(runId, { parts, streaming: ctx.subagentStreams.get(runId)?.join("") ?? null });
  } else if (agentEvent.type === "message.delta" && typeof (agentEvent.payload as { delta?: unknown }).delta === "string") {
    ctx.subagentPublisher.append(runId, (agentEvent.payload as { delta: string }).delta);
  } else if (agentEvent.type === "message.reasoning.delta" || (agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "reasoning")) {
    const payload = agentEvent.payload as { delta?: unknown; contentIndex?: number };
    ctx.subagentPublisher.appendReasoning(runId, {
      delta: typeof payload.delta === "string" ? payload.delta : "", contentIndex: payload.contentIndex,
      messageSequence: completedMessageSequence, ...(agentEvent.type === "message.block.completed" ? { complete: true } : {}),
    });
  } else if (agentEvent.type === "agent.started") {
    ctx.subagentPublisher.patch(runId, { status: "running" });
  } else if (agentEvent.type === "approval.requested") {
    ctx.subagentPublisher.patch(runId, { status: "waiting_approval" });
  } else if (["agent.completed", "agent.cancelled", "agent.failed"].includes(agentEvent.type)) {
    ctx.subagentPublisher.patch(runId, {
      status: agentEvent.type === "agent.failed" ? "failed" : agentEvent.type === "agent.cancelled" ? "cancelled" : "completed",
    });
  } else if (agentEvent.type === "message.completed" || agentEvent.type === "tool.started" || agentEvent.type === "tool.completed" || agentEvent.type === "tool.failed") {
    const messagesAppend = agentEvent.type === "message.completed"
      ? [ctx.subagentRunRepo.latestMessage(runId)].filter((message): message is NonNullable<typeof message> => Boolean(message)).map((message) => ({
        id: message.id, sequence: message.sequence,
        role: message.role as "user" | "assistant" | "tool" | "system", content: message.content,
        internal: message.role === "user" && Boolean(message.rawMessage),
        parts: message.parts ? JSON.parse(message.parts) as AssistantMessagePart[] : undefined,
        createdAt: message.createdAt,
      }))
      : undefined;
    ctx.subagentPublisher.patch(runId, {
      content: ctx.assistantBuffers.get(runId) ?? "",
      parts,
      streaming: ctx.subagentStreams.get(runId)?.join("") ?? null,
      ...(messagesAppend?.length ? { messagesAppend } : {}),
    });
  }
}

export function handleRuntimeEvent(
  ctx: RuntimeEventContext,
  busEvent: RuntimeBusEvent,
  agentEvent: AgentEvent,
  childExecution: boolean,
) {
  const updateLive = updateLiveAssistant;
  if (busEvent.type === "approval.requested" && busEvent.runId) {
    ctx.runRepo.setStatus(busEvent.runId, "waiting_approval");
    const payload = busEvent.payload as { approvalId?: string; toolCallId?: string };
    if (payload.approvalId) {
      ctx.approvalRuns.set(payload.approvalId, busEvent.runId);
      if (payload.toolCallId) {
        const toolCallId = ctx.toolCallIds.get(`${busEvent.runId}:${payload.toolCallId}`);
        if (toolCallId) {
          ctx.toolCallRepo.setStatus(toolCallId, "waiting_approval");
          ctx.approvalToolCalls.set(payload.approvalId, toolCallId);
        }
      }
    }
  }
  if (busEvent.type === "approval.resolved") {
    const payload = busEvent.payload as { approvalId?: string; toolCallId?: string; approved?: boolean };
    if (payload.approvalId) {
      const runId = ctx.approvalRuns.get(payload.approvalId) ?? busEvent.runId;
      if (runId) {
        ctx.runRepo.setStatus(runId, "running");
        const toolCallId = ctx.approvalToolCalls.get(payload.approvalId);
        if (toolCallId) ctx.toolCallRepo.setStatus(toolCallId, "running");
        const run = ctx.runRepo.get(runId);
        if (run) ctx.emit("run.status", { status: "running" }, run.sessionId, runId);
      }
      ctx.approvalRuns.delete(payload.approvalId);
      ctx.approvalToolCalls.delete(payload.approvalId);
    }
  }
  if (agentEvent.runId) {
    const parts = ctx.assistantPartsByRun.get(agentEvent.runId);
    if (parts) applyRunParts(ctx, agentEvent, parts, childExecution, updateLive);
    if (ctx.activeSubagents.has(agentEvent.runId)) {
      publishSubagentEvent(ctx, agentEvent, ctx.assistantMessageSequenceByRun.get(agentEvent.runId) ?? agentEvent.sequence, updateLive);
    }
  }
  const isSubagentExecution = agentEvent.scope === "subagent";
  if (agentEvent.sessionId && agentEvent.runId && !isSubagentExecution && isAssistantMessageActivity(agentEvent)) {
    ctx.touchSession(agentEvent.sessionId);
  }
  // Reconnects restore canonical messages and live snapshots. Persisting every
  // token in the replay journal only grows SQLite work without adding recovery
  // information.
  if (agentEvent.type !== "message.delta" && agentEvent.type !== "message.reasoning.delta") {
    ctx.queueEventPersistence(agentEvent);
  }
  // Child tokens and tool events have their own compact delta protocol. Sending
  // them again as agent.event only duplicates IPC work and is ignored by the UI.
  if (!isSubagentExecution) ctx.send({ type: "agent.event", event: agentEvent });
  if (agentEvent.type === "subagent.finished" && agentEvent.runId) {
    // Child transcripts are persisted per message by recordEvent; this run's
    // raw buffer must not outlive the child or it leaks for every delegation.
    ctx.assistantRawMessagesByRun.delete(agentEvent.runId);
    const child = ctx.subagentRunRepo.get(agentEvent.runId);
    const childRun = ctx.runRepo.get(agentEvent.runId);
    if (child && childRun) {
      const status = childRun.status === "completed" ? "completed" : childRun.status === "cancelled" ? "cancelled" : "failed";
      const directParent = ctx.subagentRunRepo.get(child.parentRunId);
      if (child.background) ctx.subagentNotificationCoordinator()?.enqueue({
        // A nested child must notify the execution session of the direct
        // parent agent, not only the root conversation session.
        sessionId: directParent?.executionSessionId ?? child.parentSessionId,
        subagentRunId: child.runId,
        // A child run can be resumed/retried and emit another terminal event.
        // The terminal timestamp makes each completion a durable idempotency key.
        version: childRun.completedAt ?? Date.now(),
        kind: status,
        title: child.title,
        content: finalSubagentSummary({
          content: child.content,
          parts: JSON.parse(child.parts) as AssistantMessagePart[],
          messages: ctx.subagentRunRepo.listMessages(child.runId),
          status,
        }),
      });
    }
  }
  if (agentEvent.type === "compaction_end" && agentEvent.sessionId && agentEvent.runId
    && (!ctx.subagentRunRepo.get(agentEvent.runId) || ctx.subagentRunRepo.getByExecutionSession(agentEvent.sessionId))) {
    ctx.subagentNotificationCoordinator()?.scheduleLedger(agentEvent.sessionId);
  }
  if (agentEvent.type === "message.completed" && (agentEvent.payload as { message?: { role?: string } }).message?.role === "user" && agentEvent.sessionId && agentEvent.runId && !ctx.subagentRunRepo.get(agentEvent.runId)) {
    const rawUser = (agentEvent.payload as { message?: unknown }).message;
    if (ctx.initialUserMessageSeen.has(agentEvent.runId)) {
      if (!isSubagentUpdatePrompt(agentEvent.payload)) ctx.deliverSteer(agentEvent.sessionId, agentEvent.runId, rawUser);
    } else {
      ctx.initialUserMessageSeen.add(agentEvent.runId);
      // The initial user row was written before the run started; attach the
      // native Pi message so a restart rebuilds the exact provider turn.
      const row = rawUser && typeof rawUser === "object"
        ? ctx.messageRepo.listBySession(agentEvent.sessionId).filter((message) => message.role === "user" && message.runId === agentEvent.runId).at(-1)
        : undefined;
      if (row) ctx.messageRepo.setRawMessage(row.id, rawUser);
    }
  }
  if ((agentEvent.type === "compaction_start" || agentEvent.type === "compaction_end") && agentEvent.sessionId && agentEvent.runId && !ctx.subagentRunRepo.get(agentEvent.runId)) {
    const payload = agentEvent.payload as { reason?: string; result?: unknown };
    if (payload.reason === "threshold" || payload.reason === "overflow") {
      const history = ctx.messageRepo.listBySession(agentEvent.sessionId);
      const throughMessageId = history.find((message) => message.role === "user" && message.runId === agentEvent.runId)?.id ?? history.at(-1)?.id;
      if (throughMessageId) {
        const position = ctx.compactionPositions.update(agentEvent.runId, agentEvent.eventId, agentEvent.timestamp, agentEvent.type === "compaction_start", ctx.assistantPartsByRun.get(agentEvent.runId) ?? []);
        if (agentEvent.type === "compaction_start") {
          ctx.emit("context.compaction.started", { ...position, throughMessageId, source: "automatic" }, agentEvent.sessionId, agentEvent.runId);
        } else {
          const status = payload.result ? "completed" : "interrupted";
          ctx.emit(status === "completed" ? "context.compacted" : "context.compaction.interrupted", { ...position, throughMessageId, createdAt: position.startedAt, status, source: "automatic" }, agentEvent.sessionId, agentEvent.runId);
          ctx.flushEvents();
        }
      }
    }
  }
}