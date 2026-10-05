




import { assistantPartsFromPiMessage, applyAssistantToolEvent, applyReasoningDelta, type AssistantMessagePart, type ArtifactInfo, type CompactionMarkerInfo, type RunInfo } from "@qone/protocol";

import { getQoneMessageQueue } from "../lib/qone-message-queue";
import { sessionStore } from "../lib/session-execution-state";


import type { ToolCall } from "../store";


import type { AgentEvent } from "@qone/protocol";

const rid = () => crypto.randomUUID();
export function handleAgentEvent(ev: AgentEvent, eventStore: ReturnType<typeof sessionStore>, dependencies: ReturnType<typeof import("../store").bridgeDependencies>) {
  const { clearDelta, pendingAgentRuns, stopRequestedSessionIds, stopRun, flushNow, queueReasoning, queueDelta, ensureStreamingToolPart, finishStopRequest, requestSessionMessages } = dependencies;

        if (ev.sessionId && ev.runId && ev.type === "context.compaction.started") {
          const p = ev.payload as { id?: unknown; throughMessageId?: unknown; partIndex?: number; startedAt?: unknown; source?: unknown } | null;
          if (p?.source === "automatic" && typeof p.id === "string" && typeof p.throughMessageId === "string" && typeof p.startedAt === "number") {
            const { id, throughMessageId, startedAt } = p;
            const { sessionId, runId } = ev;
            eventStore.setState((state) => ({ autoCompactionStatuses: { ...state.autoCompactionStatuses, [sessionId]: { id, runId, throughMessageId, startedAt, partIndex: p.partIndex } } }));
          }
        } else if (ev.sessionId && ev.runId && (ev.type === "context.compacted" || ev.type === "context.compaction.interrupted")) {
          const p = ev.payload as { id?: unknown; throughMessageId?: unknown; partIndex?: number; createdAt?: unknown; source?: unknown } | null;
          if (p?.source === "automatic" && typeof p.id === "string" && typeof p.throughMessageId === "string" && typeof p.createdAt === "number") {
            const sessionId = ev.sessionId;
            const marker: CompactionMarkerInfo = { id: p.id, runId: ev.runId, partIndex: p.partIndex, throughMessageId: p.throughMessageId, createdAt: p.createdAt, status: ev.type === "context.compacted" ? "completed" : "interrupted", source: "automatic" };
            eventStore.setState((state) => {
              const autoCompactionStatuses = { ...state.autoCompactionStatuses };
              if (autoCompactionStatuses[sessionId]?.runId === ev.runId) delete autoCompactionStatuses[sessionId];
              return {
                autoCompactionStatuses,
                ...(state.currentSessionId === sessionId ? { compactions: [...state.compactions.filter((item) => item.id !== marker.id), marker] } : {}),
              };
            });
          }
        }
        if ((ev.type === "agent.steer.delivered" || ev.type === "agent.steer.undelivered") && ev.sessionId) {
          const queueItemId = (ev.payload as { queueItemId?: unknown } | undefined)?.queueItemId;
          if (typeof queueItemId === "string") getQoneMessageQueue(ev.sessionId)?.settleSteer(queueItemId, ev.type === "agent.steer.delivered");
          if (ev.type === "agent.steer.delivered" && ev.sessionId === eventStore.getState().currentSessionId) {
            clearDelta(ev.sessionId);
            eventStore.setState({ streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [] });
          }
        }
        if (ev.runId && ev.type === "agent.started") {
          eventStore.setState((st) => ({
            messages: ev.sessionId === st.currentSessionId
              ? st.messages.map((message) => [...pendingAgentRuns.values()].some((pending) => pending.sessionId === ev.sessionId && pending.userMessageId === message.id)
                ? { ...message, persisted: true } : message)
              : st.messages,
            activeRunId: ev.runId,
            running: true,
            runningSessionIds: ev.sessionId && !st.runningSessionIds.includes(ev.sessionId) ? [...st.runningSessionIds, ev.sessionId] : st.runningSessionIds,
            completedSessionIds: ev.sessionId ? st.completedSessionIds.filter((id) => id !== ev.sessionId) : st.completedSessionIds,
            runs: st.runs.some((run) => run.id === ev.runId)
              ? st.runs
              : [{ id: ev.runId!, sessionId: ev.sessionId ?? st.currentSessionId ?? "", status: "running", startedAt: ev.timestamp }, ...st.runs],
          }));
          if (ev.sessionId && stopRequestedSessionIds.has(ev.sessionId)) stopRun(ev.sessionId, ev.runId);
        }
        const p = ev.payload as Record<string, unknown> | undefined;

        if (ev.type === "agent.waiting_subagents" && ev.runId === eventStore.getState().activeRunId) {
          const children = Array.isArray(p?.subagents) ? p.subagents : [];
          eventStore.setState({ waitingSubagents: children.flatMap((child) => {
            if (!child || typeof child !== "object") return [];
            const item = child as { runId?: unknown; title?: unknown };
            return typeof item.runId === "string" && typeof item.title === "string"
              ? [{ runId: item.runId, title: item.title }]
              : [];
          }) });
        }

        if (ev.type === "context.usage" && ev.sessionId && typeof p?.model === "string"
          && typeof p.tokens === "number" && Number.isFinite(p.tokens) && p.tokens >= 0
          && typeof p.contextWindow === "number" && Number.isFinite(p.contextWindow) && p.contextWindow > 0) {
          const usage = { sessionId: ev.sessionId, model: p.model, tokens: p.tokens, contextWindow: p.contextWindow };
          eventStore.setState((state) => state.currentSessionId === ev.sessionId && state.selectedModelId === usage.model
            && (!ev.runId || ev.runId === state.activeRunId)
            ? { contextUsage: usage, contextUsageRequestId: undefined } : state);
        }

        if (ev.type === "artifact.created" && p && typeof p.id === "string" && ev.sessionId === eventStore.getState().currentSessionId) {
          eventStore.setState((st) => ({ artifacts: st.artifacts.some((artifact) => artifact.id === p.id) ? st.artifacts : [p as unknown as ArtifactInfo, ...st.artifacts] }));
        }

        if (ev.type === "run.status" && ev.runId && typeof p?.status === "string") {
          eventStore.setState((st) => ({ runs: st.runs.map((run) => run.id === ev.runId ? { ...run, status: p.status as RunInfo["status"] } : run) }));
        }

        if (ev.type === "model.request.started" && ev.runId === eventStore.getState().activeRunId) {
          eventStore.setState({ modelRequest: { runId: ev.runId!, startedAt: ev.timestamp } });
        }

        // Product protocol event; Pi event names never cross into this reducer.
        if (ev.type === "message.started" && ev.runId === eventStore.getState().activeRunId && (p?.message as { role?: unknown } | undefined)?.role === "assistant") {
          clearDelta(ev.sessionId);
          eventStore.setState({ activeMessageSequence: ev.sequence, streaming: "", waitingSubagents: [] });
        }

        else if (ev.type === "message.block.started" && ev.runId === eventStore.getState().activeRunId) {
          flushNow(ev.sessionId);
          eventStore.setState((st) => {
            const messageSequence = st.activeMessageSequence;
            if (messageSequence === undefined) return st;
            const priorText: AssistantMessagePart[] = st.streaming
              ? [{ type: "text", text: st.streaming, messageSequence, phase: "commentary" }]
              : [];
            const newTool: AssistantMessagePart[] = p?.blockType === "tool-call"
              ? [{
                  type: "tool-call",
                  toolCallId: typeof p.toolCallId === "string" && p.toolCallId
                    ? p.toolCallId
                    : `pi-${messageSequence}-${p.contentIndex ?? st.streamingParts.length}`,
                  toolName: String(p.toolName ?? "tool"),
                  args: p.args ?? {},
                  messageSequence,
                }]
              : [];
            return { streaming: "", streamingParts: [...st.streamingParts, ...priorText, ...newTool] };
          });
        }

        else if ((ev.type === "message.block.completed" || ev.type === "message.delta") && ev.runId === eventStore.getState().activeRunId && p?.blockType === "tool-call") {
          eventStore.setState((st) => {
            const fallbackId = st.activeMessageSequence !== undefined && typeof p.contentIndex === "number"
              ? `pi-${st.activeMessageSequence}-${p.contentIndex}`
              : undefined;
            const toolCallId = typeof p.toolCallId === "string" && p.toolCallId ? p.toolCallId : fallbackId;
            const parts = st.streamingParts.map((part): AssistantMessagePart =>
              part.type === "tool-call" && part.toolCallId === fallbackId && toolCallId
                ? { ...part, toolCallId }
                : part
            );
            if (!toolCallId) return { streamingParts: parts };
            const hasStartedCall = st.toolCalls.some((call) => call.runId === ev.runId && call.toolCallId === toolCallId);
            return {
              streamingParts: applyAssistantToolEvent(parts, "tool.started", { ...p, toolCallId }),
              preparedToolCallIds: ev.type !== "message.block.completed" || hasStartedCall || st.preparedToolCallIds.includes(toolCallId)
                ? st.preparedToolCallIds
                : [...st.preparedToolCallIds, toolCallId],
            };
          });
        }

        else if (ev.type === "message.block.completed" && p?.blockType === "reasoning" && ev.runId === eventStore.getState().activeRunId) {
          flushNow(ev.sessionId);
          eventStore.setState((st) => ({ streamingParts: applyReasoningDelta(st.streamingParts, { ...p, complete: true }, st.activeMessageSequence ?? ev.sequence) }));
        }

        else if (ev.type === "message.reasoning.delta" && ev.runId === eventStore.getState().activeRunId) {
          if (typeof p?.delta === "string") queueReasoning(p.delta, typeof p.contentIndex === "number" ? p.contentIndex : undefined, ev.sessionId);
        }

        else if (ev.type === "message.delta" && ev.runId === eventStore.getState().activeRunId && typeof p?.delta === "string") {
          queueDelta(p.delta, ev.sessionId);
        }

        else if (ev.type === "message.completed" && ev.runId === eventStore.getState().activeRunId && (p?.message as { role?: unknown } | undefined)?.role === "assistant") {
          clearDelta(ev.sessionId);
          eventStore.setState((st) => {
            const messageSequence = st.activeMessageSequence ?? ev.sequence;
            const completedParts = assistantPartsFromPiMessage(p, messageSequence);
            const activeToolCallIds = new Set(
              st.toolCalls
                .filter((call) => call.runId === ev.runId)
                .map((call) => call.toolCallId),
            );
            const newlyPrepared = completedParts.flatMap((part) =>
              part.type === "tool-call" && !activeToolCallIds.has(part.toolCallId)
                ? [part.toolCallId]
                : [],
            );
            return {
              streaming: "",
              activeMessageSequence: undefined,
              streamingParts: [
                ...st.streamingParts.filter((part) => part.messageSequence !== messageSequence),
                ...completedParts,
              ],
              preparedToolCallIds: [...new Set([...st.preparedToolCallIds, ...newlyPrepared])],
            };
          });
        }

        else if (ev.type === "tool.started") {
          const toolCallId = typeof p?.toolCallId === "string" && p.toolCallId ? p.toolCallId : rid();
          const toolPayload: Record<string, unknown> & { toolCallId: string } = { ...(p ?? {}), toolCallId };
          const activeRun = ev.runId === eventStore.getState().activeRunId;
          if (activeRun) flushNow(ev.sessionId);
          const tc: ToolCall = {
            toolCallId,
            runId: ev.runId ?? "",
            toolName: String(toolPayload.toolName ?? "tool"),
            status: "running",
            startedAt: ev.timestamp,
            args: toolPayload.input ?? toolPayload.args,
            argsText: (() => {
              const value = toolPayload.input ?? toolPayload.args;
              if (typeof value === "string") return value;
              try { return JSON.stringify(value ?? {}); } catch { return "{}"; }
            })(),
          };
          eventStore.setState((st) => {
            const lastPart = st.streamingParts.at(-1);
            const messageSequence = st.activeMessageSequence
              ?? (lastPart?.type === "tool-call" ? lastPart.messageSequence : ev.sequence);
            const existing = st.toolCalls.find((t) => t.toolCallId === toolCallId);
            return {
              toolCalls: existing
                ? st.toolCalls.map((t) => t.toolCallId === toolCallId
                    ? { ...t, ...tc, startedAt: t.startedAt ?? tc.startedAt, completedAt: undefined }
                    : t)
                : [...st.toolCalls, tc],
              preparedToolCallIds: st.preparedToolCallIds.filter((id) => id !== toolCallId),
              ...(ev.runId === st.activeRunId ? {
                streaming: "",
                streamingParts: ensureStreamingToolPart(
                  st.streaming
                    ? [...st.streamingParts, { type: "text", text: st.streaming, messageSequence: st.activeMessageSequence ?? ev.sequence, phase: "commentary" }]
                    : st.streamingParts,
                  toolPayload,
                  messageSequence,
                ),
              } : {}),
            };
          });
        } else if (ev.type === "tool.updated" && ev.runId === eventStore.getState().activeRunId) {
          eventStore.setState((st) => ({
            toolCalls: st.toolCalls.map((call) =>
              call.runId === ev.runId && call.toolCallId === p?.toolCallId && (call.status === "running" || call.status === "waiting")
                ? { ...call, status: "running", result: p.update }
                : call
            ),
          }));
        } else if (ev.type === "tool.completed" || ev.type === "tool.failed") {
          const id = String(p?.toolCallId ?? "");
          const isErr = ev.type === "tool.failed" || Boolean(p?.isError ?? p?.error);
          eventStore.setState((st) => ({
            toolCalls: st.toolCalls.map((t) =>
              t.toolCallId === id
                ? {
                    ...t,
                    status: isErr ? "failed" : "success",
                    result: p?.content ?? p?.result,
                    summary: undefined,
                    completedAt: ev.timestamp,
                  }
                : t
            ),
            preparedToolCallIds: st.preparedToolCallIds.filter((preparedId) => preparedId !== id),
            streamingParts: ev.runId === st.activeRunId
              ? applyAssistantToolEvent(st.streamingParts, ev.type === "tool.failed" ? "tool.failed" : "tool.completed", p)
              : st.streamingParts,
          }));
        }

        // Approval requests from the permission layer
        else if (ev.type === "approval.requested") {
          if (ev.runId) {
            eventStore.setState((st) => ({ runs: st.runs.map((run) => run.id === ev.runId ? { ...run, status: "waiting_approval" } : run) }));
          }
          eventStore.setState((st) => ({
            toolCalls: st.toolCalls.map((tool) => tool.runId === ev.runId && tool.toolName === String(p?.toolName ?? "") && tool.status === "running" ? { ...tool, status: "waiting" } : tool),
            approvals: [
              ...st.approvals,
              {
                id: String(p?.approvalId ?? ""),
                toolName: String(p?.toolName ?? "tool"),
                args: p?.args,
              },
            ],
          }));
        }

        else if (
          ev.type === "agent.completed" ||
          ev.type === "agent.cancelled" ||
          ev.type === "agent.failed"
        ) {
          const isActiveRun = !ev.runId || ev.runId === eventStore.getState().activeRunId;
          if (isActiveRun) clearDelta(ev.sessionId);
          const completedMessage = p?.message;
          if (
            completedMessage &&
            typeof completedMessage === "object" &&
            typeof (completedMessage as { id?: unknown }).id === "string" &&
            typeof (completedMessage as { content?: unknown }).content === "string"
          ) {
            const message = completedMessage as { id: string; role?: string; content: string; parts?: AssistantMessagePart[]; runId?: string; createdAt?: number };
            eventStore.setState((st) => ({
              messages: st.messages.some((item) => item.id === message.id)
                ? st.messages
                : [...st.messages, {
                    id: message.id,
                    role: message.role ?? "assistant",
                    content: message.content,
                    parts: message.parts,
                    runId: message.runId,
                    createdAt: message.createdAt,
                  }],
            }));
          }
          if (ev.type === "agent.failed" && isActiveRun) {
            eventStore.setState((st) => {
              const userMessage = st.messages.slice().reverse().find((message) => message.role === "user");
              return userMessage && st.currentSessionId ? {
                chatRunError: {
                  sessionId: st.currentSessionId,
                  userMessageId: userMessage.id,
                  detail: typeof p?.message === "string" ? p.message : "",
                },
              } : { lastError: typeof p?.message === "string" ? p.message : "Agent failed" };
            });
          }
          if (ev.runId) {
            if (ev.sessionId) finishStopRequest(ev.sessionId, ev.runId);
            const status = ev.type === "agent.completed" ? "completed" : ev.type === "agent.cancelled" ? "cancelled" : "failed";
            eventStore.setState((st) => ({ runs: st.runs.map((run) => run.id === ev.runId ? { ...run, status, completedAt: Date.now() } : run) }));
          }
          if (isActiveRun) {
            eventStore.setState((st) => ({ streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], waitingSubagents: [], running: false, activeRunId: undefined, approvals: [], runningSessionIds: ev.sessionId ? st.runningSessionIds.filter((id) => id !== ev.sessionId) : st.runningSessionIds }));
          }
          if (ev.sessionId) {
            eventStore.setState((st) => ({ completedSessionIds: st.completedSessionIds.includes(ev.sessionId!) ? st.completedSessionIds : [...st.completedSessionIds, ev.sessionId!] }));
          }
          if (ev.type === "agent.cancelled") {
            const cancelledSessionId = ev.sessionId ?? eventStore.getState().currentSessionId;
            eventStore.setState((st) => ({ titleGeneratingSessionIds: st.titleGeneratingSessionIds.filter((id) => id !== cancelledSessionId) }));
          }
          const sessionId = ev.sessionId ?? eventStore.getState().currentSessionId;
          if (sessionId) {
            for (const pending of pendingAgentRuns.values()) {
              if (pending.sessionId === sessionId) pending.completed = true;
            }
            const state = eventStore.getState();
            requestSessionMessages(sessionId);
            state.send({ type: "session.toolCalls", requestId: rid(), sessionId });
            state.send({ type: "session.runs", requestId: rid(), sessionId });
            state.send({ type: "artifact.list", requestId: rid(), sessionId });
          }
        }
}
