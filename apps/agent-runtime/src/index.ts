import { handleSessionCommand } from "./session-commands.js";
import { handleRuntimeCommand } from "./runtime-commands.js";
import { configureBuiltinSkills } from "./builtin-skills/manager.js";
import { withRuntimeLocale, runtimeErrorInfo } from "./runtime-localization";
import { CompactionPositions } from "./compaction-position.js";
import { isAssistantMessageActivity } from "./session-activity.js";
import { SideConversationService } from "./side-conversation.js";

import { createLogger, EventBus, qoneDatabasePath, qoneConfigDatabasePath, qoneMcpDatabasePath, SequencedEventJournal } from "@qone/shared";
import type { RuntimeCommand, AgentEvent, AssistantMessagePart, SessionInfo, SubagentConfigInfo, GoalInfo, MessageAttachmentInfo, MessageQuoteInfo, SessionSearchResult } from "@qone/protocol";
import { decodeCommand, assistantPartsFromPiMessage, applyAssistantToolEvent, applyReasoningDelta, REMOVED_BUILTIN_SUBAGENT_IDS } from "@qone/protocol";
import { openDb, openConfigDb, openMcpDb, SessionRepo, MessageRepo, RunRepo, GoalRepo, SubagentRunRepo, SubagentNotificationRepo, TurnRepo, WorkspaceRepo, ToolCallRepo, McpServerRepo, ModelConfigRepo, SettingsRepo, QueueRepo, EventRepo, ArtifactRepo, PermissionRepo, SkillRepo } from "@qone/database";
import { McpManager, type McpServerConfig } from "@qone/mcp";
import { DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences, PiAdapter, type PiCompactionPreferences } from "./pi-adapter.js";
import { ApprovalQueue } from "./permissions.js";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { GeneratedArtifacts } from "./generated-artifacts.js";
import { ProjectResources } from "./project-resources.js";
import { moveDomainData } from "./domain-data.js";



import { ModelMetadataResolver } from "./model-resolver.js";
import { BrowserSyncService } from "./browser-sync.js";
import { createReachPublicTools } from "./reach-public-tools.js";
import { listReachChannels, ytDlpExecutable } from "./reach-channels.js";
import { podcastConfigured } from "./reach-podcast.js";
import { createPodcastTools } from "./reach-podcast-tools.js";


import { normalizeSubagentConfig } from "./subagents.js";
import { restoreCompactedContext, type SessionCompactionCheckpoint } from "./session-compaction.js";
import { registerSubagentDispatcher, subagentInfo } from "./subagent-runner.js";
import { finalSubagentSummary } from "./subagent-result.js";
import { createSubagentPublisher } from "./subagent-publisher.js";
import { isSubagentUpdatePrompt, SubagentNotificationCoordinator } from "./subagent-notifications.js";

import { ensureGlobalInstructions } from "./global-instructions.js";
import { ensureSystemPromptModules } from "./system-prompt.js";
import { updateLiveAssistant, type LiveAssistantState } from "./live-assistant.js";
import { createRuntimeOutput } from "./runtime-output.js";

const log = createLogger("runtime");

interface RuntimeBusEvent {
  type: string;
  payload: unknown;
  sessionId?: string;
  runId?: string;
  scope?: "conversation" | "subagent";
}

const eventBus = new EventBus<RuntimeBusEvent>();

// NDJSON over stdio: one JSON object per line on stdout.
// stderr is reserved for logs.
const output = createRuntimeOutput({ write: (line) => { process.stdout.write(line); }, intervalMs: 8, maxEvents: 32 });
const send = output.send;

// Keep the user file and its directory available before the settings UI opens.
ensureGlobalInstructions();
ensureSystemPromptModules();

// --- persistence ---
const dbPath =
  process.env.QONE_DB ??
  qoneDatabasePath();
const dbDir = path.dirname(dbPath);
if (dbDir !== ".") mkdirSync(dbDir, { recursive: true });
const db = openDb(dbPath);
const configDb = openConfigDb(dbPath === ":memory:" ? ":memory:" : qoneConfigDatabasePath());
const mcpDb = openMcpDb(dbPath === ":memory:" ? ":memory:" : qoneMcpDatabasePath());
moveDomainData(db, configDb, mcpDb);
const sessionRepo = new SessionRepo(db);
const messageRepo = new MessageRepo(db);
const runRepo = new RunRepo(db);
const goalRepo = new GoalRepo(db);
const subagentRunRepo = new SubagentRunRepo(db);
const subagentRunIds = new Set(subagentRunRepo.list().map((row) => row.runId));
const subagentNotificationRepo = new SubagentNotificationRepo(db);
const turnRepo = new TurnRepo(db);
const workspaceRepo = new WorkspaceRepo(db);
const toolCallRepo = new ToolCallRepo(db);
const mcpServerRepo = new McpServerRepo(mcpDb);
const modelConfigRepo = new ModelConfigRepo(configDb);
const runtimeSecrets = new Map<string, string>();
const settingsMetadataResolver = new ModelMetadataResolver();
const settingsRepo = new SettingsRepo(db);
const preferencesRepo = new SettingsRepo(configDb);
configureBuiltinSkills(preferencesRepo);
const queueRepo = new QueueRepo(settingsRepo);
const sideConversations = new SideConversationService(db);
const compactionPreferences: PiCompactionPreferences = normalizePiCompactionPreferences(
  preferencesRepo.get("compaction.settings") ?? DEFAULT_PI_COMPACTION_PREFERENCES,
);
const storedSubagentConfig = preferencesRepo.get<SubagentConfigInfo>("subagents.config");
let subagentConfig: SubagentConfigInfo = normalizeSubagentConfig(storedSubagentConfig);
if (Array.isArray(storedSubagentConfig?.profiles) && storedSubagentConfig.profiles.some((profile) => profile && REMOVED_BUILTIN_SUBAGENT_IDS.includes(profile.id))) {
  preferencesRepo.set("subagents.config", subagentConfig);
}
const eventRepo = new EventRepo(db);
const artifactRepo = new ArtifactRepo(db);
const projectResources = new ProjectResources();
const generatedArtifacts = new GeneratedArtifacts(
  artifactRepo,
  projectResources.root,
  (sessionId) => {
    const session = sessionRepo.get(sessionId);
    return projectResources.sessionDirectory(session?.workspaceId, sessionId);
  },
);
const permissionRepo = new PermissionRepo(configDb);
const skillRepo = new SkillRepo(db);
const eventJournal = new SequencedEventJournal<AgentEvent>(settingsRepo.get<number>("event.sequence") ?? 0);
eventJournal.restore(eventRepo.list());
const pendingEvents: AgentEvent[] = [];
const subagentStreams = new Map<string, string[]>();
const activeSubagents = new Set<string>();
const subagentPublisher = createSubagentPublisher({
  load: (id) => subagentInfo(id, subagentRunRepo, runRepo, subagentStreams, assistantPartsByRun.get(id)),
  send,
  intervalMs: 32,
});
let subagentController: ReturnType<typeof registerSubagentDispatcher>;
let subagentNotificationCoordinator: SubagentNotificationCoordinator | undefined;
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
function publishSubagent(runId: string) {
  subagentRunIds.add(runId);
  subagentPublisher.publish(runId);
}
let eventFlushTimer: ReturnType<typeof setTimeout> | undefined;
const flushEvents = () => {
  if (eventFlushTimer) clearTimeout(eventFlushTimer);
  eventFlushTimer = undefined;
  if (pendingEvents.length === 0) return;
  const batch = pendingEvents.splice(0, pendingEvents.length);
  eventRepo.addMany(batch);
  const last = batch.at(-1);
  if (last) settingsRepo.set("event.sequence", last.sequence + 1);
};
const queueEventPersistence = (event: AgentEvent) => {
  pendingEvents.push(event);
  if (pendingEvents.length >= 50) flushEvents();
  else if (!eventFlushTimer) eventFlushTimer = setTimeout(flushEvents, 32);
};

const compactionPositions = new CompactionPositions();
const liveAssistantByRun = new Map<string, LiveAssistantState>();
function runRequiresSubagentFinalization(sessionId: string, runId: string): boolean {
  const owner = subagentRunRepo.getByExecutionSession(sessionId);
  const ownerRunId = owner?.runId ?? runId;
  const ownerSessionId = owner?.parentSessionId ?? sessionId;
  const rows = subagentRunRepo.listBySession(ownerSessionId);
  const direct = rows.filter((row) => row.requiredBeforeFinal && row.parentRunId === ownerRunId);
  const recoveredRoots = !owner
    ? rows.filter((row) => row.requiredBeforeFinal && !row.parentSubagentId && row.parentRunId !== ownerRunId
      && runRepo.get(row.parentRunId)?.status === "interrupted"
      && !runRepo.isFinalizationAuthorized(row.parentRunId))
    : [];
  const recoveredRootIds = new Set(recoveredRoots.map((row) => row.runId));
  const recovered = rows.filter((row) => {
    if (!row.requiredBeforeFinal) return false;
    let current = row;
    while (current.parentSubagentId) {
      const parent = rows.find((candidate) => candidate.runId === current.parentRunId);
      if (!parent) return false;
      current = parent;
    }
    return recoveredRootIds.has(current.runId);
  });
  return [...direct, ...recovered].length > 0;
}
eventBus.subscribe((busEvent) => {
  const childExecution = busEvent.scope === "subagent" || Boolean(busEvent.runId && subagentRunIds.has(busEvent.runId));
  if (busEvent.type === "approval.requested" && busEvent.runId) {
    runRepo.setStatus(busEvent.runId, "waiting_approval");
    const payload = busEvent.payload as { approvalId?: string; toolCallId?: string };
    if (payload.approvalId) {
      approvalRuns.set(payload.approvalId, busEvent.runId);
      if (payload.toolCallId) {
        const toolCallId = toolCallIds.get(`${busEvent.runId}:${payload.toolCallId}`);
        if (toolCallId) {
          toolCallRepo.setStatus(toolCallId, "waiting_approval");
          approvalToolCalls.set(payload.approvalId, toolCallId);
        }
      }
    }
  }
  const approvalParent = busEvent.runId && busEvent.type === "approval.requested" ? subagentRunRepo.get(busEvent.runId)?.parentSessionId : undefined;
  const agentEvent = eventJournal.record((sequence) => ({
    eventId: crypto.randomUUID(), sequence, type: busEvent.type,
    sessionId: approvalParent ?? busEvent.sessionId, runId: busEvent.runId,
    timestamp: Date.now(), payload: busEvent.payload, scope: approvalParent ? "conversation" : childExecution ? "subagent" : "conversation",
  } satisfies AgentEvent), busEvent.type !== "message.delta" && busEvent.type !== "message.reasoning.delta");
  if (agentEvent.runId) {
    const live = liveAssistantByRun.get(agentEvent.runId);
    if (live) liveAssistantByRun.set(agentEvent.runId, updateLiveAssistant(live, agentEvent));
    const completedMessageSequence = assistantMessageSequenceByRun.get(agentEvent.runId) ?? agentEvent.sequence;
    const parts = assistantPartsByRun.get(agentEvent.runId);
    if (parts) {
      const messageRole = (agentEvent.payload as { message?: { role?: unknown } } | undefined)?.message?.role;
      if (agentEvent.type === "message.started" && messageRole === "assistant") {
        assistantMessageSequenceByRun.set(agentEvent.runId, agentEvent.sequence);
      } else if (agentEvent.type === "message.completed" && messageRole === "assistant") {
        const messageSequence = assistantMessageSequenceByRun.get(agentEvent.runId) ?? agentEvent.sequence;
        assistantPartsByRun.set(agentEvent.runId, [
          ...parts.filter((part) => part.messageSequence !== messageSequence),
          ...assistantPartsFromPiMessage(agentEvent.payload, messageSequence,
            runRequiresSubagentFinalization(agentEvent.sessionId ?? "", agentEvent.runId)
              && !runRepo.isFinalizationAuthorized(agentEvent.runId) ? "commentary" : undefined),
        ]);
        assistantMessageSequenceByRun.delete(agentEvent.runId);
      } else if (agentEvent.type === "message.reasoning.delta") {
        assistantPartsByRun.set(agentEvent.runId, applyReasoningDelta(parts, agentEvent.payload, completedMessageSequence));
      } else if (agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "reasoning") {
        assistantPartsByRun.set(agentEvent.runId, applyReasoningDelta(parts, { ...(agentEvent.payload as object), complete: true }, completedMessageSequence));
      } else if (agentEvent.type === "tool.started" || agentEvent.type === "tool.completed" || agentEvent.type === "tool.failed") {
        assistantPartsByRun.set(agentEvent.runId, applyAssistantToolEvent(parts, agentEvent.type, agentEvent.payload));
      }
      if (childExecution && (agentEvent.type === "message.block.started"
        || (agentEvent.type === "message.delta" || agentEvent.type === "message.block.completed") && (agentEvent.payload as { blockType?: string }).blockType === "tool-call")) {
        const current = updateLiveAssistant({ content: subagentStreams.get(agentEvent.runId)?.join("") ?? "", parts,
          messageSequence: assistantMessageSequenceByRun.get(agentEvent.runId), sequence: agentEvent.sequence }, agentEvent);
        assistantPartsByRun.set(agentEvent.runId, current.parts);
        if (current.content) subagentStreams.set(agentEvent.runId, [current.content]);
        else subagentStreams.delete(agentEvent.runId);
      }
    }
    if (activeSubagents.has(agentEvent.runId)) {
      if (agentEvent.type === "message.completed" && (agentEvent.payload as { message?: { role?: string; usage?: unknown } }).message?.role === "assistant") {
        const usage = subagentRunRepo.updateUsage(agentEvent.runId, readTokenUsage((agentEvent.payload as { message?: { usage?: unknown } }).message?.usage));
        subagentPublisher.patch(agentEvent.runId, { tokenUsage: usage });
        const budget = subagentConfig.runtime.tokenBudget;
        if (budget > 0 && usage.total >= budget) {
          subagentController.fail(agentEvent.runId, "Subagent token budget exceeded");
          emit("subagent.budget_exceeded", { budget, usage }, agentEvent.sessionId, agentEvent.runId);
        }
      }
      if (agentEvent.type === "message.delta" && (agentEvent.payload as { blockType?: string }).blockType !== "tool-call" && typeof (agentEvent.payload as { delta?: unknown }).delta === "string") {
        const chunks = subagentStreams.get(agentEvent.runId);
        if (chunks) chunks.push((agentEvent.payload as { delta: string }).delta);
        else subagentStreams.set(agentEvent.runId, [(agentEvent.payload as { delta: string }).delta]);
      }
      if (agentEvent.type === "message.completed" && (agentEvent.payload as { message?: { role?: string } }).message?.role === "assistant") {
        subagentStreams.delete(agentEvent.runId);
      }
      const parts = assistantPartsByRun.get(agentEvent.runId) ?? [];
      if (["message.completed", "tool.completed", "tool.failed"].includes(agentEvent.type)) {
        subagentRunRepo.save(agentEvent.runId, assistantBuffers.get(agentEvent.runId) ?? "", parts);
      }
      subagentController?.recordEvent(agentEvent.runId, agentEvent.type, agentEvent.payload, completedMessageSequence);
      if (agentEvent.type === "message.delta" && (agentEvent.payload as { blockType?: string }).blockType === "tool-call") {
        const runId = agentEvent.runId;
        subagentPublisher.queueParts(runId, () => assistantPartsByRun.get(runId) ?? []);
      } else if (agentEvent.type === "message.block.started" || agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "tool-call") {
        subagentPublisher.patch(agentEvent.runId, { parts, streaming: subagentStreams.get(agentEvent.runId)?.join("") ?? null });
      } else if (agentEvent.type === "message.delta" && typeof (agentEvent.payload as { delta?: unknown }).delta === "string") {
        subagentPublisher.append(agentEvent.runId, (agentEvent.payload as { delta: string }).delta);
      } else if (agentEvent.type === "message.reasoning.delta" || (agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "reasoning")) {
        const payload = agentEvent.payload as { delta?: unknown; contentIndex?: number };
        subagentPublisher.appendReasoning(agentEvent.runId, {
          delta: typeof payload.delta === "string" ? payload.delta : "", contentIndex: payload.contentIndex,
          messageSequence: completedMessageSequence, ...(agentEvent.type === "message.block.completed" ? { complete: true } : {}),
        });
      } else if (agentEvent.type === "agent.started") {
        subagentPublisher.patch(agentEvent.runId, { status: "running" });
      } else if (agentEvent.type === "approval.requested") {
        subagentPublisher.patch(agentEvent.runId, { status: "waiting_approval" });
      } else if (["agent.completed", "agent.cancelled", "agent.failed"].includes(agentEvent.type)) {
        subagentPublisher.patch(agentEvent.runId, {
          status: agentEvent.type === "agent.failed" ? "failed" : agentEvent.type === "agent.cancelled" ? "cancelled" : "completed",
        });
      } else if (agentEvent.type === "message.completed" || agentEvent.type === "tool.started" || agentEvent.type === "tool.completed" || agentEvent.type === "tool.failed") {
        const messagesAppend = agentEvent.type === "message.completed"
          ? [subagentRunRepo.latestMessage(agentEvent.runId)].filter((message): message is NonNullable<typeof message> => Boolean(message)).map((message) => ({
            id: message.id, sequence: message.sequence,
            role: message.role as "user" | "assistant" | "tool" | "system", content: message.content,
            internal: message.role === "user" && Boolean(message.rawMessage),
            parts: message.parts ? JSON.parse(message.parts) as AssistantMessagePart[] : undefined,
            createdAt: message.createdAt,
          }))
          : undefined;
        subagentPublisher.patch(agentEvent.runId, {
          content: assistantBuffers.get(agentEvent.runId) ?? "",
          parts,
          streaming: subagentStreams.get(agentEvent.runId)?.join("") ?? null,
          ...(messagesAppend?.length ? { messagesAppend } : {}),
        });
      }
    }
  }
  const isSubagentExecution = agentEvent.scope === "subagent";
  if (agentEvent.sessionId && agentEvent.runId && !isSubagentExecution && isAssistantMessageActivity(agentEvent)) {
    touchSession(agentEvent.sessionId);
  }
  // Reconnects restore canonical messages and live snapshots. Persisting every
  // token in the replay journal only grows SQLite work without adding recovery
  // information.
  if (agentEvent.type !== "message.delta" && agentEvent.type !== "message.reasoning.delta") {
    queueEventPersistence(agentEvent);
  }
  // Child tokens and tool events have their own compact delta protocol. Sending
  // them again as agent.event only duplicates IPC work and is ignored by the UI.
  if (!isSubagentExecution) send({ type: "agent.event", event: agentEvent });
  if (agentEvent.type === "subagent.finished" && agentEvent.runId) {
    const child = subagentRunRepo.get(agentEvent.runId);
    const childRun = runRepo.get(agentEvent.runId);
    if (child && childRun) {
      const status = childRun.status === "completed" ? "completed" : childRun.status === "cancelled" ? "cancelled" : "failed";
      const directParent = subagentRunRepo.get(child.parentRunId);
      if (child.background) subagentNotificationCoordinator?.enqueue({
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
          messages: subagentRunRepo.listMessages(child.runId),
          status,
        }),
      });
    }
  }
  if (agentEvent.type === "compaction_end" && agentEvent.sessionId && agentEvent.runId
    && (!subagentRunRepo.get(agentEvent.runId) || subagentRunRepo.getByExecutionSession(agentEvent.sessionId))) {
    subagentNotificationCoordinator?.scheduleLedger(agentEvent.sessionId);
  }
  if (agentEvent.type === "message.completed" && (agentEvent.payload as { message?: { role?: string } }).message?.role === "user" && agentEvent.sessionId && agentEvent.runId && !subagentRunRepo.get(agentEvent.runId)) {
    if (initialUserMessageSeen.has(agentEvent.runId)) {
      if (!isSubagentUpdatePrompt(agentEvent.payload)) deliverSteer(agentEvent.sessionId, agentEvent.runId);
    }
    else initialUserMessageSeen.add(agentEvent.runId);
  }
  if ((agentEvent.type === "compaction_start" || agentEvent.type === "compaction_end") && agentEvent.sessionId && agentEvent.runId && !subagentRunRepo.get(agentEvent.runId)) {
    const payload = agentEvent.payload as { reason?: string; result?: unknown };
    if (payload.reason === "threshold" || payload.reason === "overflow") {
      const history = messageRepo.listBySession(agentEvent.sessionId);
      const throughMessageId = history.find((message) => message.role === "user" && message.runId === agentEvent.runId)?.id ?? history.at(-1)?.id;
      if (throughMessageId) {
        const position = compactionPositions.update(agentEvent.runId, agentEvent.eventId, agentEvent.timestamp, agentEvent.type === "compaction_start", assistantPartsByRun.get(agentEvent.runId) ?? []);
        if (agentEvent.type === "compaction_start") {
          emit("context.compaction.started", { ...position, throughMessageId, source: "automatic" }, agentEvent.sessionId, agentEvent.runId);
        } else {
          const status = payload.result ? "completed" : "interrupted";
          emit(status === "completed" ? "context.compacted" : "context.compaction.interrupted", { ...position, throughMessageId, createdAt: position.startedAt, status, source: "automatic" }, agentEvent.sessionId, agentEvent.runId);
          flushEvents();
        }
      }
    }
  }
});
const assistantBuffers = new Map<string, string>();
// Raw streamed deltas per run; survives aborts so partial answers can be saved.
const assistantStreamBuffers = new Map<string, string[]>();
const assistantPartsByRun = new Map<string, AssistantMessagePart[]>();
const assistantMessageSequenceByRun = new Map<string, number>();
const pendingSteers = new Map<string, Array<{ runId: string; queueItemId: string; message: string; attachments?: MessageAttachmentInfo[]; quote?: MessageQuoteInfo }>>();
const persistedAssistantRuns = new Set<string>();
const initialUserMessageSeen = new Set<string>();
const toolCallIds = new Map<string, string>();
const cancelledRuns = new Set<string>();
const titleControllers = new Map<string, AbortController>();
const startingRunSessions = new Set<string>();
const goalContinuationTimers = new Map<string, ReturnType<typeof setTimeout>>();

// Persist whatever the run produced so far (final text, streamed deltas, tool parts).
function persistPartialAssistant(sessionId: string, runId: string, model?: string) {
  const parts = assistantPartsByRun.get(runId) ?? [];
  const streamText = assistantStreamBuffers.get(runId)?.join("").trim() ?? "";
  const partsText = parts
    .filter((part): part is Extract<AssistantMessagePart, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n\n")
    .trim();
  const content = streamText || assistantBuffers.get(runId)?.trim() || partsText;
  if (!content && !parts.length) return undefined;
  return messageRepo.addAssistant(sessionId, content, runId, model, parts);
}

function deliverSteer(sessionId: string, runId: string) {
  const pending = pendingSteers.get(sessionId);
  if (!pending?.length || pending[0]?.runId !== runId) return;
  const steer = pending.shift()!;
  if (!pending.length) pendingSteers.delete(sessionId);
  const assistant = persistPartialAssistant(sessionId, runId);
  if (assistant) persistedAssistantRuns.add(runId);
  assistantBuffers.delete(runId);
  assistantStreamBuffers.delete(runId);
  assistantPartsByRun.set(runId, []);
  assistantMessageSequenceByRun.delete(runId);
  const live = liveAssistantByRun.get(runId);
  if (live) liveAssistantByRun.set(runId, { content: "", parts: [], sequence: live.sequence });
  const userMessage = messageRepo.add(sessionId, "user", steer.message, runId, undefined, steer.queueItemId, steer.attachments, undefined, undefined, steer.quote);
  touchSession(sessionId, userMessage.createdAt);
  queueRepo.remove(sessionId, steer.queueItemId);
  sendQueue(sessionId);
  // Send canonical history before the UI clears transient streaming parts.
  // This keeps the interrupted assistant/tool segment above the new steer.
  sendMessages(sessionId);
  emit("agent.steer.delivered", { queueItemId: steer.queueItemId }, sessionId, runId);
}

function releaseUndeliveredSteers(sessionId: string, runId: string) {
  const pending = pendingSteers.get(sessionId);
  if (!pending) return;
  const undelivered = pending.filter((steer) => steer.runId === runId);
  const remaining = pending.filter((steer) => steer.runId !== runId);
  if (remaining.length) pendingSteers.set(sessionId, remaining);
  else pendingSteers.delete(sessionId);
  if (undelivered.length) adapter.clearSessionQueue(sessionId);
  for (const steer of undelivered) {
    const items = queueRepo.list(sessionId);
    if (items.some((candidate) => candidate.id === steer.queueItemId)) {
      queueRepo.replace(sessionId, items.map((item) => item.id === steer.queueItemId
        ? { ...item, lane: "queue", status: "queued", updatedAt: Date.now() }
        : item));
    }
    emit("agent.steer.undelivered", { queueItemId: steer.queueItemId }, sessionId, runId);
  }
  if (undelivered.length) sendQueue(sessionId);
}
const activeSubagentStatuses = new Set(["created", "running", "waiting_approval", "paused"]);
const interruptedSubagents = subagentRunRepo.list().filter((row) => activeSubagentStatuses.has(runRepo.get(row.runId)?.status ?? ""));
const approvalRuns = new Map<string, string>();
const approvalToolCalls = new Map<string, string>();
const commandApprovals = new ApprovalQueue();
runRepo.markInterrupted(); // any run still "running" was killed with last process
turnRepo.markInterrupted();
toolCallRepo.markInterrupted();

const adapter = new PiAdapter((event) => eventBus.emit({
  type: event.type,
  payload: event.payload,
  sessionId: event.sessionId,
  runId: event.runId,
}), {
  onAssistantFinal: (_sessionId, runId, content) => {
    if (content.trim()) assistantBuffers.set(runId, content);
  },
  onMessage: (_sessionId, runId, role, delta) => {
    if (role === "assistant") {
      const chunks = assistantStreamBuffers.get(runId);
      if (chunks) chunks.push(delta);
      else assistantStreamBuffers.set(runId, [delta]);
    }
  },
  onTool: (sessionId, runId, phase, name, args, result, toolCallId) => {
    if (phase === "start") {
      const row = toolCallRepo.start(runId, name, args, toolCallId);
      if (toolCallId) toolCallIds.set(`${runId}:${toolCallId}`, row.id);
    } else if (toolCallId) {
      const id = toolCallIds.get(`${runId}:${toolCallId}`);
      if (id) {
        toolCallRepo.finish(id, result && (result as { isError?: boolean }).isError ? "failed" : "success", result);
        toolCallIds.delete(`${runId}:${toolCallId}`);
      }
    }
  },
  onCustomEntry: (sessionId, entry) => {
    const entries = settingsRepo.get<unknown[]>(`codemode.entries:${sessionId}`) ?? [];
    if (entry && typeof entry === "object") settingsRepo.set(`codemode.entries:${sessionId}`, [...entries, entry]);
  },
  onGeneratedMedia: async (executionSessionId, runId, data, mimeType, extension, signal) => {
    const sessionId = subagentRunRepo.getByExecutionSession(executionSessionId)?.parentSessionId ?? executionSessionId;
    const saved = await generatedArtifacts.save({ sessionId, runId, data, mimeType, extension, signal });
    emit("artifact.created", { ...saved, runId: saved.runId ?? undefined, mimeType: saved.mimeType ?? undefined, size: saved.size ?? undefined }, sessionId, runId);
    return saved.path;
  },
}, permissionRepo, (sessionId, currentRunId) => {
  const subagent = subagentRunRepo.getByExecutionSession(sessionId);
  if (subagent) {
    return subagentRunRepo.listMessages(subagent.runId).map((message) => ({
      role: message.role, content: message.content, createdAt: message.createdAt,
      rawMessage: message.rawMessage ? JSON.parse(message.rawMessage) : undefined,
    }));
  }
  const history = messageRepo.listBySession(sessionId).filter((message) => message.runId !== currentRunId).map((message) => ({
    id: message.id,
    role: message.role,
    content: message.content,
    attachments: message.attachments ? JSON.parse(message.attachments) : undefined,
    createdAt: message.createdAt,
  }));
  const customEntries = settingsRepo.get<unknown[]>(`codemode.entries:${sessionId}`) ?? [];
  history.push(...customEntries.map((rawMessage) => ({ id: crypto.randomUUID(), role: "custom", content: "", attachments: undefined, createdAt: Date.now(), rawMessage })));
  return restoreCompactedContext(history, settingsRepo.get<SessionCompactionCheckpoint>(`compaction:${sessionId}`));
}, compactionPreferences);
adapter.setSideConversationResolver((sessionId) => Boolean(sideConversations.metadata(sessionId)));
subagentNotificationCoordinator = new SubagentNotificationCoordinator(
  subagentNotificationRepo,
  subagentRunRepo,
  runRepo,
  adapter,
  sendSubagentNotifications,
);
for (const child of interruptedSubagents) {
  const directParent = subagentRunRepo.get(child.parentRunId);
  subagentNotificationCoordinator.enqueue({
    sessionId: directParent?.executionSessionId ?? child.parentSessionId,
    subagentRunId: child.runId,
    version: runRepo.get(child.runId)?.completedAt ?? Date.now(),
    kind: "interrupted",
    title: child.title,
    content: "该子代理因运行时重启而中断。",
  });
}
subagentController = registerSubagentDispatcher({
  adapter, sessionRepo, workspaceRepo, runRepo, subagentRunRepo,
  config: () => subagentConfig,
  partsByRun: assistantPartsByRun, messageSequenceByRun: assistantMessageSequenceByRun,
  assistantBuffers, streamBuffers: assistantStreamBuffers, subagentStreams, activeSubagents,
  contextProvider: (sessionId, limit) => messageRepo.listBySession(sessionId).slice(-limit).map((message) => `${message.role}: ${message.content}`).join("\n\n"),
  subagentContextProvider: (runId, limit) => subagentRunRepo.listMessages(runId).slice(-limit).map((message) => `${message.role}: ${message.content}`).join("\n\n"),
  attachmentsProvider: (sessionId, runId) => messageRepo.listBySession(sessionId).flatMap((message) =>
    message.runId === runId && message.role === "user" && message.attachments ? JSON.parse(message.attachments) as MessageAttachmentInfo[] : []),
  runtime: () => subagentConfig.runtime,
  acknowledge: (runId) => subagentNotificationCoordinator?.acknowledge(runId),
  publish: publishSubagent, emit: (type, payload, sessionId, runId) => eventBus.emit({ type, payload, sessionId, runId, scope: "subagent" }),
});
adapter.setSubagentController(subagentController);
const publishGoal = (goal: GoalInfo) => send({ type: "goal.updated", goal });
const currentGoalForTool = (sessionId: string, goalId: string, epoch: number, runId: string) => {
    const goal = goalRepo.get(goalId);
  const run = runRepo.get(runId);
  const current = goalRepo.getBySession(sessionId);
  if (!goal || current?.id !== goalId || goal.sessionId !== sessionId || goal.epoch !== epoch || goal.status !== "active" ||
      !run || run.sessionId !== sessionId || run.goalId !== goalId || run.goalEpoch !== epoch || run.status !== "running" ||
      cancelledRuns.has(runId)) throw new Error("goal run is no longer active");
  return goal;
};
 adapter.setGoalBridge({
   get: (sessionId, goalId, epoch, runId) => currentGoalForTool(sessionId, goalId, epoch, runId),
   complete: (sessionId, goalId, epoch, runId, summary) => {
     currentGoalForTool(sessionId, goalId, epoch, runId);
    const updated = goalRepo.update(goalId, { status: "complete", waitingReason: null, waitingUntil: null, stopReason: summary });
     goalRepo.event(goalId, sessionId, "completed", { summary }, runId);
    publishGoal(updated);
    return updated;
  },
   blocked: (sessionId, goalId, epoch, runId, reason, evidence) => {
     currentGoalForTool(sessionId, goalId, epoch, runId);
    const updated = goalRepo.update(goalId, { status: "blocked", waitingReason: null, waitingUntil: null, stopReason: `${reason}\n${evidence}` });
     goalRepo.event(goalId, sessionId, "blocked", { reason, evidence }, runId);
    publishGoal(updated);
    return updated;
  },
   wait: (sessionId, goalId, epoch, runId, reason, resumeAfterMs) => {
     currentGoalForTool(sessionId, goalId, epoch, runId);
    const updated = goalRepo.update(goalId, { waitingReason: reason, waitingUntil: resumeAfterMs ? Date.now() + resumeAfterMs : null });
     goalRepo.event(goalId, sessionId, "waiting", { reason, resumeAfterMs }, runId);
    publishGoal(updated);
    if (resumeAfterMs && resumeAfterMs > 0) {
      scheduleGoalWakeup(sessionId, goalId, reason, updated.waitingUntil!);
    }
    return updated;
  },
});
await adapter.configureModels(modelConfigRepo.list());
for (const [permission, decision] of [
  ["agent.delegate", "allow"],
  ["filesystem.write", "ask"],
  ["shell.execute", "ask"],
  ["network", "ask"],
  ["clipboard.read", "ask"],
  ["clipboard.write", "ask"],
  ["windows.control", "ask"],
  ["secret.read", "ask"],
  ["mcp.connect", "ask"],
  ["mcp.execute", "ask"],
  ["tool.execute", "ask"],
] as const) permissionRepo.ensure("builtin", permission, decision);
const pendingMcpAuthRequests = new Map<string, string>();

const mcp = new McpManager(async (serverId, token) => {
  const config = mcpServerRepo.list().find((server) => server.id === serverId);
  if (token) {
    const key = config?.oauth?.tokenSecretKey ?? `mcp.oauth:${serverId}`;
    runtimeSecrets.set(key, token);
    send({ type: "mcp.oauth.token", requestId: "oauth-callback", serverId, key, accessToken: token });
  }
  if (config) {
    await mcp.disconnect(serverId);
    try {
      const tools = await mcp.connect(config);
      await refreshCustomTools();
      send({ type: "mcp.connected", serverId, toolCount: tools.length });
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      pendingMcpAuthRequests.delete(serverId);
    } catch (error) {
      log.warn("MCP OAuth reconnect failed", { serverId, err: String(error) });
      const requestId = pendingMcpAuthRequests.get(serverId);
      if (requestId) send({ type: "error", requestId, ...runtimeErrorInfo(error) });
      pendingMcpAuthRequests.delete(serverId);
    }
  }
}, (serverId, kind, value) => {
  send({ type: "mcp.oauth.credential", serverId, key: `mcp.oauth:${serverId}.${kind}`, value });
}, (serverId, authorization) => {
  send({ type: "mcp.oauth.authorization", requestId: pendingMcpAuthRequests.get(serverId) ?? crypto.randomUUID(), serverId, ...authorization });
}, (serverId, error) => {
  const requestId = pendingMcpAuthRequests.get(serverId);
  pendingMcpAuthRequests.delete(serverId);
  if (requestId) send({ type: "error", requestId, ...runtimeErrorInfo(error) });
}, (key) => runtimeSecrets.get(key), async (config) => {
  const key = config.oauth?.tokenSecretKey ?? `mcp.oauth:${config.id}`;
  runtimeSecrets.delete(key);
  send({ type: "mcp.oauth.invalidated", serverId: config.id, key });
  await refreshCustomTools();
  send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
}, (config, credential) => {
  // Rotated tokens replace the persisted pair; the old refresh token is already spent.
  const key = config.oauth?.tokenSecretKey ?? `mcp.oauth:${config.id}`;
  runtimeSecrets.set(key, credential);
  send({ type: "mcp.oauth.token", requestId: "oauth-refresh", serverId: config.id, key, accessToken: credential });
});
for (const config of [...mcpServerRepo.list(), ...loadMcpConfigs()] as McpServerConfig[]) {
  // Playwright remains available as a manually enabled fallback. OpenCLI is
  // the default browser channel, so starting Playwright here would launch a
  // second browser and compete with the current Chrome connection.
  if (config.id === "mcp-playwright") continue;
  const subjectId = `mcp:${config.id}`;
  permissionRepo.ensure(subjectId, "mcp.connect", "ask");
  if (permissionRepo.get(subjectId, "mcp.connect") !== "allow") continue;
  try {
    await mcp.connect(config);
    log.info("mcp connected", { serverId: config.id });
  } catch (err) {
    log.warn("mcp connection failed", { serverId: config.id, err: String(err) });
  }
}
let browserSync: BrowserSyncService | undefined;
await refreshCustomTools();
browserSync = new BrowserSyncService(db, dbPath,
  (status) => {
    send({ type: "browser.status", status });
    sendReachChannels();
  }, refreshCustomTools);
await browserSync.initialize();

async function releaseBrowserSession() {
  try { await browserSync?.release(); }
  catch (error) { log.warn("browser session release failed", { err: String(error) }); }
}

async function refreshCustomTools() {
  await adapter.setCustomTools([
    ...mcp.tools(),
    ...createReachPublicTools({ ytDlp: ytDlpExecutable, xueqiuCookie: () => runtimeSecrets.get("reach.xueqiu.cookie") }),
    ...createPodcastTools(() => runtimeSecrets.get("reach.groq.apiKey")),
    ...(browserSync?.tools() ?? []),
  ]);
}

function sendReachChannels(requestId?: string) {
  send({ type: "reach.channels", requestId, channels: listReachChannels({
    browserConnected: browserSync?.status().targetConnected ?? false,
    mcpConnected: (id) => mcp.isConnected(id),
    hasXueqiuCookie: Boolean(runtimeSecrets.get("reach.xueqiu.cookie")),
    podcastConfigured: podcastConfigured(),
    hasGroqKey: Boolean(runtimeSecrets.get("reach.groq.apiKey")),
  }) });
}

function loadMcpConfigs() {
  const raw = process.env.QONE_MCP_SERVERS;
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return (Array.isArray(parsed)
      ? parsed
      : Object.entries(parsed).map(([id, value]) => ({ id, ...(value as object) }))) as Array<{
      id: string; name: string; command: string; args?: string[]; env?: Record<string, string>;
    }>;
  } catch (err) {
    log.warn("invalid QONE_MCP_SERVERS", { err: String(err) });
    return [];
  }
}

const toInfo = (s: {
  id: string;
  title: string;
  workspaceId: string | null | undefined;
  createdAt: number;
  updatedAt: number;
  lastUserMessageAt: number;
}): SessionInfo => {
  const info: SessionInfo = {
    id: s.id,
    title: s.title,
    workspaceId: s.workspaceId ?? undefined,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
    lastUserMessageAt: s.lastUserMessageAt,
    sideChat: sideConversations.metadata(s.id),
  };
  projectResources.session(info);
  return info;
};

for (const workspace of workspaceRepo.list()) projectResources.project(workspace);
for (const session of sessionRepo.list()) toInfo(session);

function touchSession(sessionId: string, userMessageAt?: number) {
  if (userMessageAt === undefined) sessionRepo.touch(sessionId);
  else sessionRepo.touchUserMessage(sessionId, userMessageAt);
  const session = sessionRepo.get(sessionId);
  if (session) send({ type: "session.updated", session: toInfo(session) });
}

const emit = (type: string, payload: unknown, sessionId?: string, runId?: string) =>
  eventBus.emit({ type, payload, sessionId, runId });

function sendQueue(sessionId: string, sendEvent: typeof send = send) {
  sendEvent({ type: "session.queue", sessionId, items: queueRepo.list(sessionId) });
}

function sendSubagentNotifications(sessionId: string, sendEvent: typeof send = send) {
  sendEvent({ type: "session.subagentNotifications", sessionId, notifications: subagentNotificationRepo.listUnacknowledged(sessionId) });
}

function sendMessages(sessionId: string, requestId?: string, sendEvent: typeof send = send) {
  const history = messageRepo.listBySession(sessionId);
  const messageIds = new Set(history.map((message) => message.id));
  const compactions = eventRepo.listCompactions(sessionId).filter((marker) => messageIds.has(marker.throughMessageId));
  const activeRun = runRepo.listBySession(sessionId).find((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status));
  const live = activeRun ? liveAssistantByRun.get(activeRun.id) : undefined;
  sendEvent({
    type: "session.messages", requestId, sessionId,
    messages: history.map((m) => ({
      id: m.id, sessionId: m.sessionId, runId: m.runId ?? undefined,
      role: m.role, content: m.content,
      quote: m.quote ? JSON.parse(m.quote) as MessageQuoteInfo : undefined,
      parts: m.parts ? JSON.parse(m.parts) as AssistantMessagePart[] : undefined,
      attachments: m.attachments ? JSON.parse(m.attachments) : undefined,
      model: m.model ?? undefined, goalId: m.goalId ?? undefined, createdAt: m.createdAt,
    })),
    compactions,
    ...(activeRun && live ? { streaming: { runId: activeRun.id, content: live.content, parts: live.parts, messageSequence: live.messageSequence, sequence: live.sequence } } : {}),
  });
}

function searchSessions(query: string): SessionSearchResult[] {
  const needle = query.trim().toLocaleLowerCase();
  if (!needle) return [];
  const results: SessionSearchResult[] = [];
  for (const result of sessionRepo.search(query, 50)) {
    if (sideConversations.metadata(result.session.id)) continue;
    if (result.match === "title") {
      results.push({ session: toInfo(result.session), match: "title" });
      continue;
    }
    const content = result.content?.replace(/\s+/g, " ").trim() ?? "";
    const matchIndex = content.toLocaleLowerCase().indexOf(needle);
    const start = Math.max(0, matchIndex - 48);
    const end = Math.min(content.length, matchIndex + needle.length + 96);
    results.push({ session: toInfo(result.session), match: "content", snippet: `${start > 0 ? "…" : ""}${content.slice(start, end)}${end < content.length ? "…" : ""}` });
  }
  return results;
}

async function authorizeCommand(subjectId: string, permission: string, toolName: string, args: unknown) {
  const decision = permissionRepo.get(subjectId, permission) ?? "ask";
  if (decision === "deny") throw new Error(`${toolName} denied by permission policy`);
  if (decision === "allow") return;
  const approvalId = crypto.randomUUID();
  const approval = commandApprovals.request(approvalId, toolName, args);
  emit("approval.requested", { approvalId, toolName, args });
  if (!await approval) throw new Error(`${toolName} rejected by user`);
}

function scheduleGoalContinuation(sessionId: string, goalId: string, epoch: number) {
  if (goalContinuationTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    goalContinuationTimers.delete(sessionId);
    const goal = goalRepo.get(goalId);
    if (!goal || goal.sessionId !== sessionId || goal.status !== "active" || goal.epoch !== epoch || goal.waitingReason || queueRepo.list(sessionId).length > 0) return;
    const options = goalRepo.getOptions(goalId);
    void handle({
      type: "agent.run", requestId: crypto.randomUUID(), sessionId,
      message: `Continue working toward the goal. Inspect the current state, make the next useful changes, and call goal_complete only when the goal is fully verified. If a real blocker prevents progress, call goal_blocked with evidence.\n\nGoal: ${goal.objective}`,
      goal: true, goalContinuation: true, ...options,
    });
  }, 0);
  goalContinuationTimers.set(sessionId, timer);
}

function scheduleGoalWakeup(sessionId: string, goalId: string, reason: string, waitingUntil: number) {
  if (goalContinuationTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    if (goalContinuationTimers.get(sessionId) === timer) goalContinuationTimers.delete(sessionId);
    const current = goalRepo.get(goalId);
    if (!current || current.status !== "active" || current.waitingReason !== reason || current.waitingUntil !== waitingUntil) return;
    const resumed = goalRepo.update(goalId, { waitingReason: null, waitingUntil: null });
    goalRepo.event(goalId, sessionId, "resumed", { source: "wait_expired" });
    publishGoal(resumed);
    scheduleGoalContinuation(sessionId, goalId, resumed.epoch);
  }, Math.max(0, waitingUntil - Date.now()));
  goalContinuationTimers.set(sessionId, timer);
}



function sendSubagentConfig(requestId?: string) {
  send({ type: "subagent.list", requestId, config: subagentConfig });
}

export function runtimeCommandServices() {
  return {
    adapter,
    approvalRuns,
    approvalToolCalls,
    artifactRepo,
    assistantBuffers,
    assistantMessageSequenceByRun,
    assistantPartsByRun,
    assistantStreamBuffers,
    authorizeCommand,
    get browserSync() { return browserSync; },
    set browserSync(value: typeof browserSync) { browserSync = value; },
    cancelledRuns,
    commandApprovals,
    emit,
    eventJournal,
    eventRepo,
    flushEvents,
    generatedArtifacts,
    projectResources,
    goalContinuationTimers,
    goalRepo,
    initialUserMessageSeen,
    liveAssistantByRun,
    log,
    mcp,
    mcpServerRepo,
    messageRepo,
    modelConfigRepo,
    pendingMcpAuthRequests,
    pendingSteers,
    permissionRepo,
    preferencesRepo,
    persistPartialAssistant,
    persistedAssistantRuns,
    publishGoal,
    handle,
    queueRepo,
    refreshCustomTools,
    releaseBrowserSession,
    releaseUndeliveredSteers,
    runRepo,
    runtimeSecrets,
    scheduleGoalContinuation,
    scheduleGoalWakeup,
    searchSessions,
    send,
    sendBatch: output.sendBatch,
    sendMessages,
    sendQueue,
    sendReachChannels,
    sendSubagentConfig,
    sendSubagentNotifications,
    sessionRepo,
    settingsMetadataResolver,
    settingsRepo,
    sideConversations,
    skillRepo,
    startingRunSessions,
    get subagentConfig() { return subagentConfig; },
    set subagentConfig(value: typeof subagentConfig) { subagentConfig = value; },
    get subagentController() { return subagentController; },
    set subagentController(value: typeof subagentController) { subagentController = value; },
    get subagentNotificationCoordinator() { return subagentNotificationCoordinator; },
    set subagentNotificationCoordinator(value: typeof subagentNotificationCoordinator) { subagentNotificationCoordinator = value; },
    subagentPublisher,
    subagentRunRepo,
    subagentStreams,
    titleControllers,
    toInfo,
    toolCallIds,
    toolCallRepo,
    touchSession,
    turnRepo,
    workspaceRepo,
  };
}

async function handle(cmd: RuntimeCommand): Promise<void> {
  const services = runtimeCommandServices();
  if (await handleSessionCommand(cmd, services) || await handleRuntimeCommand(cmd, services)) return;
  send({ type: "error", requestId: cmd.requestId, message: `unhandled command ${cmd.type}` });
}

// Read NDJSON commands from stdin.
const decoder = new TextDecoder();
const reader = Bun.stdin.stream().getReader();
let buf = "";
while (true) {
  const { value, done } = await reader.read();
  if (done) break;
  buf += decoder.decode(value, { stream: true });
  let idx;
  while ((idx = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, idx);
    buf = buf.slice(idx + 1);
    const cmd = decodeCommand(line);
    if (!cmd) {
      // A newer GUI may send a command this runtime does not know. Reply to
      // correlated requests instead of leaving the GUI waiting for a timeout.
      try {
        const raw = JSON.parse(line) as { requestId?: unknown; type?: unknown };
        if (typeof raw.requestId === "string") send({ type: "error", requestId: raw.requestId, message: `invalid or unsupported command: ${String(raw.type ?? "unknown")}` });
      } catch { /* Ignore malformed input without a request ID. */ }
      continue;
    }
    withRuntimeLocale(cmd.locale, () => handle(cmd).catch((err) => {
      log.error("command failed", { err: String(err) });
      // Send the bare message so error codes such as SKILL_CATALOG_TIMEOUT arrive without an "Error: " prefix.
      send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(err) });
    }));
  }
}

await mcp.disconnectAll();
for (const session of adapter.getSessions()) {
  try { await session.dispose(); } catch (error) { log.warn("Pi session dispose failed", { err: String(error) }); }
}
flushEvents();
subagentPublisher.dispose();
