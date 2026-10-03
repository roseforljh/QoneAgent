import { runtimeText, withRuntimeLocale, runtimeErrorInfo } from "./runtime-localization";
import { CompactionPositions } from "./compaction-position.js";
import { isAssistantMessageActivity } from "./session-activity.js";
import { SideConversationService } from "./side-conversation.js";
import { repeatedUserMessageId } from "@qone/protocol";
import { createLogger, EventBus, SequencedEventJournal } from "@qone/shared";
import type { RuntimeCommand, RuntimeEvent, AgentEvent, AssistantMessagePart, SessionInfo, WorkspaceInfo, PermissionDecision, SubagentConfigInfo, GoalInfo, MessageAttachmentInfo, MessageQuoteInfo, SessionSearchResult } from "@qone/protocol";
import { encode, decodeCommand, assistantPartsFromPiMessage, applyAssistantToolEvent, applyReasoningDelta, thinkingLevelsForApi, parseMcpCommand, REMOVED_BUILTIN_SUBAGENT_IDS } from "@qone/protocol";
import { openDb, SessionRepo, MessageRepo, RunRepo, GoalRepo, SubagentRunRepo, SubagentNotificationRepo, TurnRepo, WorkspaceRepo, ToolCallRepo, McpServerRepo, ModelConfigRepo, SettingsRepo, QueueRepo, EventRepo, ArtifactRepo, PermissionRepo, SkillRepo } from "@qone/database";
import { McpManager, type McpServerConfig } from "@qone/mcp";
import { DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences, PiAdapter, type PiCompactionPreferences } from "./pi-adapter.js";
import { ApprovalQueue } from "./permissions.js";
import path from "node:path";
import { existsSync, mkdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { GeneratedArtifacts } from "./generated-artifacts.js";
import { createLocalSkill, createResourceLoader, installLocalSkill } from "./skills.js";
import { installCloudSkill, listCloudSkills } from "./skill-catalog.js";
import { containsSecretConfig } from "./secrets.js";
import { ModelMetadataResolver } from "./model-resolver.js";
import { BrowserSyncService } from "./browser-sync.js";
import { createReachPublicTools } from "./reach-public-tools.js";
import { listReachChannels, ytDlpExecutable } from "./reach-channels.js";
import { configurePodcast, podcastConfigured } from "./reach-podcast.js";
import { createPodcastTools } from "./reach-podcast-tools.js";
import { listWorkspaceFiles, readWorkspaceFile, workspaceGit, workspaceDiff } from "./workspace.js";
import { readFilePreview } from "./file-preview.js";
import { normalizeSubagentConfig } from "./subagents.js";
import { restoreCompactedContext, type SessionCompactionCheckpoint } from "./session-compaction.js";
import { registerSubagentDispatcher, subagentInfo } from "./subagent-runner.js";
import { finalSubagentSummary } from "./subagent-result.js";
import { createSubagentPublisher } from "./subagent-publisher.js";
import { SubagentNotificationCoordinator } from "./subagent-notifications.js";
import { generatedSessionTitle, provisionalSessionTitle } from "./session-title.js";
import { ensureGlobalInstructions, globalInstructionsDirectory, globalInstructionsPath, readGlobalInstructions, writeGlobalInstructions } from "./global-instructions.js";
import { updateLiveAssistant, type LiveAssistantState } from "./live-assistant.js";

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
let pendingStreamOutput: RuntimeEvent[] = [];
let streamOutputTimer: ReturnType<typeof setTimeout> | undefined;
const flushStreamOutput = () => {
  if (streamOutputTimer) clearTimeout(streamOutputTimer);
  streamOutputTimer = undefined;
  if (!pendingStreamOutput.length) return;
  const batch = pendingStreamOutput;
  pendingStreamOutput = [];
  process.stdout.write(encode(batch));
};
const send = (msg: RuntimeEvent) => {
  const event = msg.type === "agent.event" ? msg.event : undefined;
  const streamEvent = event?.type === "message.delta" || event?.type === "message.reasoning.delta";
  if (!streamEvent) {
    flushStreamOutput();
    return process.stdout.write(encode(msg));
  }
  pendingStreamOutput.push(msg);
  if (pendingStreamOutput.length >= 32) flushStreamOutput();
  else if (!streamOutputTimer) streamOutputTimer = setTimeout(flushStreamOutput, 8);
};

// Keep the user file and its directory available before the settings UI opens.
ensureGlobalInstructions();

// --- persistence ---
const dbPath =
  process.env.QONE_DB ??
  path.join(process.env.APPDATA ?? process.env.HOME ?? process.cwd(), "QoneAgent", "agent.db");
const dbDir = path.dirname(dbPath);
if (dbDir !== ".") mkdirSync(dbDir, { recursive: true });
const db = openDb(dbPath);
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
const mcpServerRepo = new McpServerRepo(db);
const modelConfigRepo = new ModelConfigRepo(db);
const runtimeSecrets = new Map<string, string>();
const settingsMetadataResolver = new ModelMetadataResolver();
const settingsRepo = new SettingsRepo(db);
const queueRepo = new QueueRepo(settingsRepo);
const sideConversations = new SideConversationService(db);
const compactionPreferences: PiCompactionPreferences = normalizePiCompactionPreferences(
  settingsRepo.get("compaction.settings") ?? DEFAULT_PI_COMPACTION_PREFERENCES,
);
const storedSubagentConfig = settingsRepo.get<SubagentConfigInfo>("subagents.config");
let subagentConfig: SubagentConfigInfo = normalizeSubagentConfig(storedSubagentConfig);
if (Array.isArray(storedSubagentConfig?.profiles) && storedSubagentConfig.profiles.some((profile) => profile && REMOVED_BUILTIN_SUBAGENT_IDS.includes(profile.id))) {
  settingsRepo.set("subagents.config", subagentConfig);
}
const eventRepo = new EventRepo(db);
const artifactRepo = new ArtifactRepo(db);
const generatedArtifacts = new GeneratedArtifacts(artifactRepo, dbPath === ":memory:" ? tmpdir() : dbDir);
const permissionRepo = new PermissionRepo(db);
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
  } satisfies AgentEvent));
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
          ...assistantPartsFromPiMessage(agentEvent.payload, messageSequence),
        ]);
        assistantMessageSequenceByRun.delete(agentEvent.runId);
      } else if (agentEvent.type === "message.reasoning.delta") {
        assistantPartsByRun.set(agentEvent.runId, applyReasoningDelta(parts, agentEvent.payload, completedMessageSequence));
      } else if (agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "reasoning") {
        assistantPartsByRun.set(agentEvent.runId, applyReasoningDelta(parts, { ...(agentEvent.payload as object), complete: true }, completedMessageSequence));
      } else if (agentEvent.type === "tool.started" || agentEvent.type === "tool.completed" || agentEvent.type === "tool.failed") {
        assistantPartsByRun.set(agentEvent.runId, applyAssistantToolEvent(parts, agentEvent.type, agentEvent.payload));
      }
    }
    if (activeSubagents.has(agentEvent.runId)) {
      if (agentEvent.type === "message.completed" && (agentEvent.payload as { message?: { role?: string; usage?: unknown } }).message?.role === "assistant") {
        const usage = subagentRunRepo.updateUsage(agentEvent.runId, readTokenUsage((agentEvent.payload as { message?: { usage?: unknown } }).message?.usage));
        const budget = subagentConfig.runtime.tokenBudget;
        if (budget > 0 && usage.total >= budget) {
          subagentController.fail(agentEvent.runId, "Subagent token budget exceeded");
          emit("subagent.budget_exceeded", { budget, usage }, agentEvent.sessionId, agentEvent.runId);
        }
      }
      if (agentEvent.type === "message.delta" && typeof (agentEvent.payload as { delta?: unknown }).delta === "string") {
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
      if (agentEvent.type === "message.delta" && typeof (agentEvent.payload as { delta?: unknown }).delta === "string") {
        subagentPublisher.append(agentEvent.runId, (agentEvent.payload as { delta: string }).delta);
      } else if (agentEvent.type === "message.reasoning.delta" || (agentEvent.type === "message.block.completed" && (agentEvent.payload as { blockType?: string }).blockType === "reasoning")) {
        const payload = agentEvent.payload as { delta?: unknown; contentIndex?: number };
        subagentPublisher.appendReasoning(agentEvent.runId, {
          delta: typeof payload.delta === "string" ? payload.delta : "", contentIndex: payload.contentIndex,
          messageSequence: completedMessageSequence, ...(agentEvent.type === "message.block.completed" ? { complete: true } : {}),
        });
      } else if (agentEvent.type === "agent.started") {
        publishSubagent(agentEvent.runId);
      } else if (agentEvent.type === "approval.requested") {
        subagentPublisher.patch(agentEvent.runId, { status: "waiting_approval" });
      } else if (["agent.completed", "agent.cancelled", "agent.failed"].includes(agentEvent.type)) {
        const status = (agentEvent.payload as { status?: unknown }).status;
        subagentPublisher.patch(agentEvent.runId, {
          status: status === "cancelled" || status === "failed" || status === "completed" ? status : "completed",
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
    if (initialUserMessageSeen.has(agentEvent.runId)) deliverSteer(agentEvent.sessionId, agentEvent.runId);
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
}): SessionInfo => ({
  id: s.id,
  title: s.title,
  workspaceId: s.workspaceId ?? undefined,
  createdAt: s.createdAt,
  updatedAt: s.updatedAt,
  lastUserMessageAt: s.lastUserMessageAt,
  sideChat: sideConversations.metadata(s.id),
});

function touchSession(sessionId: string, userMessageAt?: number) {
  if (userMessageAt === undefined) sessionRepo.touch(sessionId);
  else sessionRepo.touchUserMessage(sessionId, userMessageAt);
  const session = sessionRepo.get(sessionId);
  if (session) send({ type: "session.updated", session: toInfo(session) });
}

const emit = (type: string, payload: unknown, sessionId?: string, runId?: string) =>
  eventBus.emit({ type, payload, sessionId, runId });

function sendQueue(sessionId: string) {
  send({ type: "session.queue", sessionId, items: queueRepo.list(sessionId) });
}

function sendSubagentNotifications(sessionId: string) {
  send({ type: "session.subagentNotifications", sessionId, notifications: subagentNotificationRepo.listUnacknowledged(sessionId) });
}

function sendMessages(sessionId: string, requestId?: string) {
  const history = messageRepo.listBySession(sessionId);
  const messageIds = new Set(history.map((message) => message.id));
  const compactions = eventRepo.listCompactions(sessionId).filter((marker) => messageIds.has(marker.throughMessageId));
  const activeRun = runRepo.listBySession(sessionId).find((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status));
  const live = activeRun ? liveAssistantByRun.get(activeRun.id) : undefined;
  send({
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

async function handle(cmd: RuntimeCommand): Promise<void> {
  switch (cmd.type) {
    case "ping":
      send({
        type: "pong",
        requestId: cmd.requestId,
        compaction: adapter.getCompactionPreferences(),
        capabilities: [
          "model.resolve-metadata",
          "model.metadata-sources",
          "workspace.explorer.v2",
          "workspace.files",
          "workspace.git",
          "workspace.gitDiff",
          "file.read",
          "file.preview",
          "browser.connect",
          "reach.channels",
          "reach.podcast.configure",
          "subagents.v1",
          "subagent.notifications",
        ],
      });
      return;

    case "session.create": {
      if (!workspaceRepo.get(cmd.workspaceId)) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown workspace ${cmd.workspaceId}` });
        return;
      }
      const s = sessionRepo.create(cmd.title, cmd.workspaceId);
      send({ type: "session.created", session: toInfo(s) });
      return;
    }

    case "session.side-chat.create": {
      try {
        const session = sideConversations.create(cmd);
        send({ type: "session.side-chat.created", requestId: cmd.requestId, sessionId: cmd.sessionId, queueItemId: cmd.queueItemId, session });
        if (cmd.queueItemId) sendQueue(cmd.sessionId);
        sendMessages(session.id);
        sendQueue(session.id);
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return;
    }

    case "session.generate-title": {
      const provisional = provisionalSessionTitle(cmd.prompt);
      const current = sessionRepo.get(cmd.sessionId);
      if (!current) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown session ${cmd.sessionId}` });
        return;
      }
      if (current.title !== "New session") {
        send({ type: "session.renamed", session: toInfo(current) });
        return;
      }
      send({ type: "session.renamed", session: toInfo(sessionRepo.rename(cmd.sessionId, provisional)) });
      const controller = new AbortController();
      titleControllers.set(cmd.sessionId, controller);
      try {
        const title = generatedSessionTitle(await adapter.generateTitle(cmd.prompt, cmd.model, controller.signal));
        if (!controller.signal.aborted && title && sessionRepo.get(cmd.sessionId)?.title === provisional && title !== provisional) {
          send({ type: "session.renamed", session: toInfo(sessionRepo.rename(cmd.sessionId, title)) });
        }
      } catch (error) {
        if (!controller.signal.aborted) log.warn("title generation failed", { sessionId: cmd.sessionId, error: String(error) });
      } finally {
        if (titleControllers.get(cmd.sessionId) === controller) titleControllers.delete(cmd.sessionId);
      }
      return;
    }

    case "session.list": {
      const workspaceIds = new Set(workspaceRepo.list().map((workspace) => workspace.id));
      const all = sessionRepo.list().filter((session) => session.workspaceId && workspaceIds.has(session.workspaceId)).map(toInfo);
      send({
        type: "session.list",
        sessions: all.filter((session) => !session.sideChat),
        sideChats: all.filter((session) => session.sideChat),
      });
      return;
    }

    case "session.search":
      send({ type: "session.search", requestId: cmd.requestId, query: cmd.query, results: searchSessions(cmd.query) });
      return;

    case "session.rename": {
      try {
        send({ type: "session.renamed", session: toInfo(sessionRepo.rename(cmd.sessionId, cmd.title)) });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return;
    }

    case "session.delete":
      if (sideConversations.metadata(cmd.sessionId)) {
        titleControllers.get(cmd.sessionId)?.abort();
        const active = runRepo.listBySession(cmd.sessionId).filter((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status));
        for (const run of active) { adapter.stop(run.id); cancelledRuns.add(run.id); }
        const stopped = await Promise.all(active.map((run) => adapter.waitForRun(run.id)));
        if (stopped.some((done) => !done)) {
          send({ type: "error", requestId: cmd.requestId, message: "side conversation is still stopping" });
          return;
        }
      }
      for (const child of sessionRepo.list().filter((session) => sideConversations.metadata(session.id)?.parentSessionId === cmd.sessionId)) {
        await handle({ type: "session.delete", requestId: crypto.randomUUID(), sessionId: child.id });
      }
      await subagentController.dispose(cmd.sessionId);
      await adapter.disposeSession(cmd.sessionId);
      const deletedGoalTimer = goalContinuationTimers.get(cmd.sessionId);
      if (deletedGoalTimer) { clearTimeout(deletedGoalTimer); goalContinuationTimers.delete(cmd.sessionId); }
      const generatedFiles = artifactRepo.listBySession(cmd.sessionId);
      sessionRepo.delete(cmd.sessionId);
      settingsRepo.set(`queue:${cmd.sessionId}`, []);
      settingsRepo.set(`side-chat:${cmd.sessionId}`, null);
      await generatedArtifacts.removeFiles(generatedFiles);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "session.messages":
      sendMessages(cmd.sessionId, cmd.requestId);
      return;

    case "goal.get": {
      const goal = goalRepo.getBySession(cmd.sessionId);
      send({ type: "goal.current", sessionId: cmd.sessionId, ...(goal ? { goal } : {}) });
      if (goal?.status === "active") {
        if (goal.waitingUntil && goal.waitingReason) scheduleGoalWakeup(cmd.sessionId, goal.id, goal.waitingReason, goal.waitingUntil);
        else if (!goal.waitingReason && !runRepo.listBySession(cmd.sessionId).some((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status))) {
          scheduleGoalContinuation(cmd.sessionId, goal.id, goal.epoch);
        }
      }
      return;
    }

    case "goal.start": {
      const session = sessionRepo.get(cmd.sessionId);
      if (!session || !session.workspaceId) {
        send({ type: "error", requestId: cmd.requestId, message: "select a workspace before starting a goal" });
        return;
      }
      if (!cmd.objective.trim()) {
        send({ type: "error", requestId: cmd.requestId, message: "goal objective cannot be empty" });
        return;
      }
      const previous = goalRepo.getBySession(cmd.sessionId);
      if (cmd.replaceFromMessageId && !messageRepo.listBySession(cmd.sessionId).some((message) => message.id === cmd.replaceFromMessageId && message.role === "user")) {
        send({ type: "error", requestId: cmd.requestId, message: "user message not found in session" });
        return;
      }
      const activeRun = runRepo.listBySession(cmd.sessionId).find((run) =>
        !subagentRunRepo.get(run.id) && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (startingRunSessions.has(cmd.sessionId) ||
          (activeRun && activeRun.goalId !== previous?.id) ||
          (adapter.isRunning(cmd.sessionId) && activeRun?.goalId !== previous?.id)) {
        send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return;
      }
      if (previous && ["active", "paused", "blocked"].includes(previous.status)) {
        const active = runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === previous.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
        if (active) { adapter.stop(active.id); cancelledRuns.add(active.id); await adapter.waitForRun(active.id); }
        const timer = goalContinuationTimers.get(cmd.sessionId);
        if (timer) { clearTimeout(timer); goalContinuationTimers.delete(cmd.sessionId); }
      }
      if (previous) {
        goalRepo.deleteForSession(cmd.sessionId);
      }
      // Rebuild the Pi session so a session that was created for a normal
      // message receives the Goal tools before the kickoff turn.
      await adapter.disposeSession(cmd.sessionId);
      const goal = goalRepo.create(cmd.sessionId, cmd.objective, { model: cmd.model, permissionMode: cmd.permissionMode, thinking: cmd.thinking });
      publishGoal(goal);
      await handle({ type: "agent.run", requestId: cmd.requestId, sessionId: cmd.sessionId, message: cmd.objective, goal: true, attachments: cmd.attachments, quote: cmd.quote, messageId: cmd.messageId, replaceFromMessageId: cmd.replaceFromMessageId, model: cmd.model, permissionMode: cmd.permissionMode, thinking: cmd.thinking });
      return;
    }

    case "goal.pause": {
      const goal = goalRepo.getBySession(cmd.sessionId);
      if (!goal) throw new Error("no goal in this session");
      if (goal.status !== "active") throw new Error("only an active goal can be paused");
      const active = runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (active) { adapter.stop(active.id); cancelledRuns.add(active.id); }
      const timer = goalContinuationTimers.get(cmd.sessionId);
      if (timer) { clearTimeout(timer); goalContinuationTimers.delete(cmd.sessionId); }
      const updated = goalRepo.update(goal.id, { status: "paused", waitingReason: null, waitingUntil: null, stopReason: cmd.reason ?? "Paused by user", bumpEpoch: true });
      goalRepo.event(goal.id, cmd.sessionId, "paused", { reason: cmd.reason ?? "Paused by user" });
      publishGoal(updated);
      return;
    }

    case "goal.resume": {
      const goal = goalRepo.getBySession(cmd.sessionId);
      if (!goal) throw new Error("no goal in this session");
      if (goal.status === "complete") throw new Error("completed goal cannot be resumed");
      if (goal.status === "active" && !goal.waitingReason) throw new Error("goal is already active");
      const active = runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (active) { adapter.stop(active.id); cancelledRuns.add(active.id); await adapter.waitForRun(active.id); }
      const resumeTimer = goalContinuationTimers.get(cmd.sessionId);
      if (resumeTimer) { clearTimeout(resumeTimer); goalContinuationTimers.delete(cmd.sessionId); }
      const updated = goalRepo.update(goal.id, { status: "active", waitingReason: null, waitingUntil: null, stopReason: null, bumpEpoch: true });
      goalRepo.event(goal.id, cmd.sessionId, "resumed", {});
      publishGoal(updated);
      const options = goalRepo.getOptions(goal.id);
      void handle({ type: "agent.run", requestId: crypto.randomUUID(), sessionId: cmd.sessionId, message: `Continue working toward the goal. Re-check the current state, make the next useful changes, and call goal_complete when the goal is fully verified.\n\nGoal: ${updated.objective}`, goal: true, goalContinuation: true, ...options });
      return;
    }

    case "goal.clear": {
      const goal = goalRepo.getBySession(cmd.sessionId);
      if (goal) {
        const active = runRepo.listBySession(cmd.sessionId).find((run) => run.goalId === goal.id && ["created", "running", "waiting_approval", "paused"].includes(run.status));
        if (active) { adapter.stop(active.id); cancelledRuns.add(active.id); await adapter.waitForRun(active.id); }
        const timer = goalContinuationTimers.get(cmd.sessionId);
        if (timer) { clearTimeout(timer); goalContinuationTimers.delete(cmd.sessionId); }
        goalRepo.deleteForSession(cmd.sessionId);
        send({ type: "goal.cleared", sessionId: cmd.sessionId, goalId: goal.id });
      }
      return;
    }

    case "session.queue.list":
      sendQueue(cmd.sessionId);
      return;

    case "queue.upsert":
      if (cmd.item.sessionId !== cmd.sessionId) {
        send({ type: "error", requestId: cmd.requestId, message: "queue item session mismatch" });
        return;
      }
      queueRepo.upsert(cmd.item);
      sendQueue(cmd.sessionId);
      return;

    case "queue.edit":
      if (cmd.item.sessionId !== cmd.sessionId) {
        send({ type: "error", requestId: cmd.requestId, message: "queue item session mismatch" });
        return;
      }
      queueRepo.upsert(cmd.item);
      sendQueue(cmd.sessionId);
      return;

    case "queue.sync":
      if (cmd.items.some((item) => item.sessionId !== cmd.sessionId)) {
        send({ type: "error", requestId: cmd.requestId, message: "queue item session mismatch" });
        return;
      }
      queueRepo.replace(cmd.sessionId, cmd.items);
      sendQueue(cmd.sessionId);
      return;

    case "queue.remove":
      queueRepo.remove(cmd.sessionId, cmd.queueItemId);
      sendQueue(cmd.sessionId);
      return;

    case "session.runs":
      send({
        type: "session.runs",
        sessionId: cmd.sessionId,
        runs: runRepo.listBySession(cmd.sessionId).filter((run) => !subagentRunRepo.get(run.id)).map((r) => ({
          id: r.id,
          sessionId: r.sessionId,
          status: r.status as never,
          startedAt: r.startedAt ?? undefined,
          completedAt: r.completedAt ?? undefined,
          error: r.error ?? undefined,
        })),
      });
      return;

    case "session.toolCalls":
      send({ type: "session.toolCalls", sessionId: cmd.sessionId, toolCalls: toolCallRepo.listBySession(cmd.sessionId).filter((call) => !subagentRunRepo.get(call.runId)).map((t) => ({
        id: t.id, runId: t.runId, toolName: t.toolName,
        arguments: t.arguments ?? undefined, resultSummary: t.resultSummary ?? undefined,
        status: t.status, startedAt: t.startedAt ?? undefined, completedAt: t.completedAt ?? undefined,
      })) });
      return;

    case "session.subagents":
      send({ type: "session.subagents", sessionId: cmd.sessionId, subagents: subagentRunRepo.listBySession(cmd.sessionId).flatMap((row) => {
        const info = subagentInfo(row.runId, subagentRunRepo, runRepo, subagentStreams);
        return info ? [info] : [];
      }) });
      return;

    case "session.subagentNotifications":
      sendSubagentNotifications(cmd.sessionId);
      return;

    case "artifact.list":
      send({ type: "artifact.list", sessionId: cmd.sessionId, artifacts: artifactRepo.listBySession(cmd.sessionId).map((artifact) => ({
        id: artifact.id, sessionId: artifact.sessionId, runId: artifact.runId ?? undefined, type: artifact.type, name: artifact.name,
        path: artifact.path, mimeType: artifact.mimeType ?? undefined, size: artifact.size ?? undefined, createdAt: artifact.createdAt,
      })) });
      return;

    case "workspace.list":
      send({ type: "workspace.list", workspaces: workspaceRepo.list() as WorkspaceInfo[] });
      return;

    case "workspace.upsert": {
      const workspacePath = path.resolve(cmd.path);
      if (!existsSync(workspacePath) || !statSync(workspacePath).isDirectory()) {
        send({ type: "error", requestId: cmd.requestId, message: `workspace directory does not exist: ${cmd.path}` });
        return;
      }
      send({ type: "workspace.updated", workspace: workspaceRepo.upsert(cmd.name, workspacePath) as WorkspaceInfo });
      return;
    }

    case "workspace.rename": {
      try {
        send({ type: "workspace.renamed", workspace: workspaceRepo.rename(cmd.workspaceId, cmd.name) as WorkspaceInfo });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return;
    }

    case "workspace.delete":
      if (!workspaceRepo.get(cmd.workspaceId)) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown workspace ${cmd.workspaceId}` });
        return;
      }
      workspaceRepo.delete(cmd.workspaceId);
      send({ type: "workspace.deleted", workspaceId: cmd.workspaceId });
      return;

    case "file.preview": {
      const workspace = cmd.workspaceId ? workspaceRepo.get(cmd.workspaceId) : undefined;
      if (cmd.workspaceId && !workspace) throw new Error("Unknown workspace");
      send({ type: cmd.type, requestId: cmd.requestId, workspaceId: cmd.workspaceId, path: cmd.path, file: await readFilePreview(cmd.path, workspace?.path, cmd.full) });
      return;
    }
    case "workspace.files":
    case "workspace.git":
    case "workspace.gitDiff":
    case "file.read": {
      const workspace = workspaceRepo.get(cmd.workspaceId);
      if (!workspace) throw new Error("Unknown workspace");
      const context = { requestId: cmd.requestId, workspaceId: workspace.id };
      if (cmd.type === "workspace.files") {
        send({ type: cmd.type, ...context, path: cmd.path ?? "", files: await listWorkspaceFiles(workspace.path, cmd.path) });
      } else if (cmd.type === "workspace.git") {
        send({ type: cmd.type, ...context, ...await workspaceGit(workspace.path) });
      } else if (cmd.type === "workspace.gitDiff") {
        send({ type: cmd.type, ...context, path: cmd.path, ...await workspaceDiff(workspace.path, cmd.path, cmd.scope) });
      } else {
        send({ type: cmd.type, ...context, path: cmd.path, ...await readWorkspaceFile(workspace.path, cmd.path) });
      }
      return;
    }
    case "skills.list": {
      const requestedCwd = cmd.cwd ? path.resolve(cmd.cwd) : process.cwd();
      if (cmd.cwd && !workspaceRepo.list().some((workspace) => path.resolve(workspace.path).toLowerCase() === requestedCwd.toLowerCase())) {
        send({ type: "error", requestId: cmd.requestId, message: "skills path is outside registered workspaces" });
        return;
      }
      const { skills } = await createResourceLoader(requestedCwd);
      for (const skill of skills) skillRepo.upsert(skill);
      send({ type: "skills.list", skills });
      return;
    }

    case "global-prompt.get":
      send({ type: "global-prompt", requestId: cmd.requestId, content: readGlobalInstructions(), path: globalInstructionsPath(), directory: globalInstructionsDirectory() });
      return;

    case "global-prompt.set":
      try {
        writeGlobalInstructions(cmd.content);
        await adapter.refreshSkills();
        send({ type: "global-prompt", requestId: cmd.requestId, content: cmd.content, path: globalInstructionsPath(), directory: globalInstructionsDirectory() });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.failed_to_save_qone_md", { p0: String(error) }) });
      }
      return;

    case "skills.cloud.list": {
      const page = await listCloudSkills(cmd.collection, cmd.page, cmd.query);
      send({ type: "skills.cloud.list", requestId: cmd.requestId, ...page });
      return;
    }
    case "skills.cloud.install": {
      const skill = await installCloudSkill(cmd.source, cmd.skillId);
      await adapter.refreshSkills();
      skillRepo.upsert(skill);
      send({ type: "skills.cloud.installed", requestId: cmd.requestId, skill });
      return;
    }
    case "skills.import": {
      const skill = await installLocalSkill(cmd.content);
      await adapter.refreshSkills();
      skillRepo.upsert(skill);
      send({ type: "skills.imported", requestId: cmd.requestId, skill });
      return;
    }
    case "skills.create": {
      const skill = await createLocalSkill(cmd.name, cmd.description, cmd.instructions);
      await adapter.refreshSkills();
      skillRepo.upsert(skill);
      send({ type: "skills.created", requestId: cmd.requestId, skill });
      return;
    }

    case "plugins.list":
      send({ type: "plugins.list", plugins: [] });
      return;

    case "browser.status":
      send({ type: "browser.status", requestId: cmd.requestId, status: browserSync!.status() });
      return;

    case "reach.channels":
      sendReachChannels(cmd.requestId);
      return;

    case "reach.podcast.configure":
      configurePodcast(cmd.accessToken, cmd.refreshToken);
      send({ type: "pong", requestId: cmd.requestId });
      sendReachChannels();
      return;

    case "subagent.list":
      sendSubagentConfig(cmd.requestId);
      return;

    case "subagent.sync":
      subagentConfig = normalizeSubagentConfig(cmd.config);
      settingsRepo.set("subagents.config", subagentConfig);
      sendSubagentConfig(cmd.requestId);
      return;

    case "subagent.query": {
      const subagent = subagentController.query(cmd.runId);
      if (!subagent) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown subagent ${cmd.runId}` });
        return;
      }
      send({ type: "subagent.query", requestId: cmd.requestId, subagent });
      return;
    }

    case "subagent.control": {
      try {
        const subagent = await subagentController.control(cmd.runId, cmd.action, cmd.message);
        send({ type: "subagent.controlled", requestId: cmd.requestId, subagent });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return;
    }

    case "browser.connect":
      try {
        const status = await browserSync!.connect();
        send({ type: "browser.status", requestId: cmd.requestId, status });
      } catch {
        // Browser failures already update the integration status. Avoid showing
        // the same error a second time in the page-wide banner.
        send({ type: "browser.status", requestId: cmd.requestId, status: browserSync!.status() });
      }
      return;

    case "mcp.list":
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      return;

    case "mcp.connect": {
      const subjectId = `mcp:${cmd.config.id}`;
      permissionRepo.ensure(subjectId, "mcp.connect", "ask");
      await authorizeCommand(subjectId, "mcp.connect", "mcp.connect", { id: cmd.config.id, name: cmd.config.name, command: cmd.config.command, url: cmd.config.url });
      mcpServerRepo.upsert(cmd.config);
      // The saved configuration is enabled immediately; connecting the transport
      // (especially a first-time npx download) can take much longer.
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      await mcp.disconnect(cmd.config.id);
      let connectError: string | undefined;
      try {
        if (cmd.config.authMode === "oauth" && !mcp.hasHostedToken(cmd.config)) {
          pendingMcpAuthRequests.set(cmd.config.id, cmd.requestId);
          const authorization = await mcp.beginOAuth(cmd.config);
          if (authorization) {
            send({ type: "mcp.oauth.authorization", requestId: cmd.requestId, serverId: cmd.config.id, ...authorization });
            setTimeout(() => {
              if (pendingMcpAuthRequests.get(cmd.config.id) !== cmd.requestId) return;
              pendingMcpAuthRequests.delete(cmd.config.id);
              send({ type: "error", requestId: cmd.requestId, message: "MCP account login timed out" });
            }, 10 * 60_000);
            return;
          }
          pendingMcpAuthRequests.delete(cmd.config.id);
        }
        if (cmd.config.authMode === "github-device") {
          pendingMcpAuthRequests.set(cmd.config.id, cmd.requestId);
          const result = await mcp.connectGitHub(cmd.config);
          if (result.device) {
            // connectGitHub starts the device flow internally. Reuse the
            // shared callback wiring for the completion and error lifecycle.
            const device = result.device;
            send({ type: "mcp.github.device", serverId: cmd.config.id, userCode: device.userCode, verificationUri: device.verificationUri, expiresAt: device.expiresAt });
            void device.completion.catch((error) => {
              if (pendingMcpAuthRequests.get(cmd.config.id) !== cmd.requestId) return;
              pendingMcpAuthRequests.delete(cmd.config.id);
              send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
            });
            return;
          }
          pendingMcpAuthRequests.delete(cmd.config.id);
        }
        const tools = await mcp.connect(cmd.config);
        await refreshCustomTools();
        send({ type: "mcp.connected", serverId: cmd.config.id, toolCount: tools.length });
      } catch (err) {
        pendingMcpAuthRequests.delete(cmd.config.id);
        connectError = String(err instanceof Error ? err.message : err);
      }
      // 无论成败都推列表：配置已持久化，前端必须立即看到新条目和连接状态，
      // 失败时 connectError 通过 error 事件透出，服务以"未连接"留在列表里。
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      if (connectError) send({ type: "error", requestId: cmd.requestId, message: connectError });
      return;
    }

    case "mcp.delete": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown MCP server ${cmd.serverId}` });
        return;
      }
      await mcp.disconnect(cmd.serverId);
      mcp.clearCredentials(cmd.serverId);
      pendingMcpAuthRequests.delete(cmd.serverId);
      mcpServerRepo.delete(cmd.serverId);
      for (const value of Object.values(config.env ?? {})) {
        if (value.startsWith("$mcp.env:")) runtimeSecrets.delete(value.slice(1));
      }
      await adapter.deleteSecret(config.oauth?.tokenSecretKey ?? `mcp.oauth:${cmd.serverId}`);
      await refreshCustomTools();
      send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
      return;
    }

    case "mcp.oauth.begin": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      await authorizeCommand(`mcp:${config.id}`, "mcp.connect", "mcp.oauth", { id: config.id, name: config.name });
      const auth = await mcp.beginOAuth(config);
      if (auth) send({ type: "mcp.oauth.authorization", requestId: cmd.requestId, serverId: cmd.serverId, url: auth.url, state: auth.state });
      return;
    }

    case "mcp.oauth.complete": {
      const config = mcpServerRepo.list().find((server) => server.id === cmd.serverId);
      if (!config) throw new Error(`unknown MCP server ${cmd.serverId}`);
      await mcp.completeOAuth(config, cmd.code, cmd.state, cmd.iss);
      // completeOAuth emits the token event and reconnects through the same
      // callback for browser redirects and manual code entry.
      return;
    }

    case "permission.list":
      send({ type: "permission.list", rules: permissionRepo.list().map((rule) => ({
        subjectId: rule.subjectId,
        permission: rule.permission,
        decision: rule.decision as PermissionDecision,
        updatedAt: rule.updatedAt,
      })) });
      return;

    case "permission.set": {
      const rule = permissionRepo.set(cmd.subjectId, cmd.permission, cmd.decision);
      send({ type: "permission.updated", rule: {
        subjectId: rule.subjectId,
        permission: rule.permission,
        decision: rule.decision,
        updatedAt: rule.updatedAt,
      } });
      return;
    }

    case "compaction.settings.set": {
      const preferences = adapter.setCompactionPreferences(cmd);
      settingsRepo.set("compaction.settings", preferences);
      send({ type: "pong", requestId: cmd.requestId, compaction: preferences });
      return;
    }

    case "session.compact": {
      const session = sessionRepo.get(cmd.sessionId);
      const cwd = session?.workspaceId ? workspaceRepo.get(session.workspaceId)?.path : undefined;
      if (!session || !cwd) {
        send({ type: "error", requestId: cmd.requestId, message: "session workspace not found" });
        return;
      }
      if (startingRunSessions.has(cmd.sessionId) || adapter.isRunning(cmd.sessionId) ||
          runRepo.listBySession(cmd.sessionId).some((run) => !subagentRunRepo.get(run.id) && ["created", "running", "waiting_approval", "paused"].includes(run.status))) {
        send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return;
      }
      const history = messageRepo.listBySession(cmd.sessionId);
      if (!history.length) {
        send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.there_is_no_session_content_to_compact") });
        return;
      }
      try {
        const context = await adapter.compactSession(cmd.sessionId, cwd, cmd.model);
        try {
          settingsRepo.set(`compaction:${cmd.sessionId}`, { throughMessageId: history.at(-1)!.id, context } satisfies SessionCompactionCheckpoint);
        } catch (error) {
          // The SQLite transcript is still intact; discard the unsaved Pi state.
          await adapter.disposeSession(cmd.sessionId);
          throw error;
        }
        touchSession(cmd.sessionId);
        const marker = { id: cmd.requestId, throughMessageId: history.at(-1)!.id, createdAt: Date.now(), status: "completed" as const, source: "manual" as const };
        emit("context.compacted", marker, cmd.sessionId);
        flushEvents();
        send({ type: "session.compacted", requestId: cmd.requestId, sessionId: cmd.sessionId, marker });
      } catch (error) {
        const marker = { id: cmd.requestId, throughMessageId: history.at(-1)!.id, createdAt: Date.now(), status: "interrupted" as const, source: "manual" as const };
        emit("context.compaction.interrupted", marker, cmd.sessionId);
        flushEvents();
        send({ type: "session.compactionInterrupted", requestId: cmd.requestId, sessionId: cmd.sessionId, marker, message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    case "session.context.get": {
      const session = sessionRepo.get(cmd.sessionId);
      const cwd = session?.workspaceId ? workspaceRepo.get(session.workspaceId)?.path : undefined;
      if (!session || !cwd) {
        send({ type: "error", requestId: cmd.requestId, message: "session workspace not found" });
        return;
      }
      try {
        const usage = await adapter.getContextUsage(cmd.sessionId, cwd, cmd.model);
        send({ type: "session.context", requestId: cmd.requestId, sessionId: cmd.sessionId, model: cmd.model, ...usage });
      } catch (error) {
        send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
      }
      return;
    }

    case "model.list":
      await adapter.configureModels(modelConfigRepo.list());
      send({ type: "model.list", configs: modelConfigRepo.list() });
      return;

    case "model.resolve-metadata": {
      const models = await Promise.all(cmd.models.map(async ({ id, metadata }) => {
        const resolved = await settingsMetadataResolver.resolve({ provider: cmd.provider, model: id, config: { apiType: cmd.apiType, baseUrl: cmd.baseUrl, autoMetadata: true, modelMetadata: metadata } });
        return { id, metadata: resolved.metadata, thinkingLevels: [...thinkingLevelsForApi(cmd.apiType)], sources: resolved.sources };
      }));
      send({ type: "model.metadata-resolved", requestId: cmd.requestId, models });
      return;
    }

    case "model.upsert": {
      if (containsSecretConfig(cmd.config.config)) {
        send({ type: "error", requestId: cmd.requestId, message: "model secrets must be stored in Windows Credential Manager" });
        return;
      }
      const config = modelConfigRepo.upsert(cmd.config);
      await adapter.configureModels(modelConfigRepo.list());
      send({ type: "model.updated", config });
      return;
    }

    case "model.delete":
      modelConfigRepo.delete(cmd.id);
      await adapter.configureModels(modelConfigRepo.list());
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "events.replay": {
      const after = cmd.afterSequence ?? -1;
      send({
        type: "events.replay",
        events: eventJournal.replay(after, cmd.sessionId),
      });
      return;
    }

    case "secret.set": {
      if (cmd.key === "reach.xueqiu.cookie" || cmd.key === "reach.groq.apiKey") {
        runtimeSecrets.set(cmd.key, cmd.value);
        send({ type: "secret.saved", requestId: cmd.requestId });
        sendReachChannels();
        return;
      }
      if (cmd.key.startsWith("mcp.env:")) {
        runtimeSecrets.set(cmd.key, cmd.value);
        const config = mcpServerRepo.list().find((server) => Object.values(server.env ?? {}).includes(`$${cmd.key}`));
        if (config && permissionRepo.get(`mcp:${config.id}`, "mcp.connect") === "allow") {
          try {
            await mcp.disconnect(config.id);
            const tools = await mcp.connect(config);
            await refreshCustomTools();
            send({ type: "mcp.connected", serverId: config.id, toolCount: tools.length });
          } catch (error) {
            await refreshCustomTools();
            log.warn("MCP API key restore failed", { serverId: config.id, err: String(error) });
          }
          send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
        }
        send({ type: "secret.saved", requestId: cmd.requestId });
        return;
      }
      const mcpSecret = mcpServerRepo.list().find((server) =>
        server.oauth?.tokenSecretKey === cmd.key || `mcp.oauth:${server.id}` === cmd.key ||
        (server.authMode === "oauth" && [`mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`].includes(cmd.key)));
      if (!mcpSecret && cmd.key === "mcp.oauth:mcp-github") {
        mcp.setAccessToken("mcp-github", cmd.value);
        send({ type: "secret.saved", requestId: cmd.requestId });
        return;
      }
      if (mcpSecret) {
        if (mcpSecret.authMode === "oauth" && cmd.key.endsWith(".client")) mcp.restoreHostedCredential(mcpSecret, "client", cmd.value);
        else if (mcpSecret.authMode === "oauth" && cmd.key.endsWith(".tokens")) mcp.restoreHostedCredential(mcpSecret, "tokens", cmd.value);
        else mcp.setAccessToken(mcpSecret.id, cmd.value);
        if (cmd.key !== `mcp.oauth:${mcpSecret.id}.client` && permissionRepo.get(`mcp:${mcpSecret.id}`, "mcp.connect") === "allow") {
          try {
            await mcp.disconnect(mcpSecret.id);
            const tools = await mcp.connect(mcpSecret);
            await refreshCustomTools();
            send({ type: "mcp.connected", serverId: mcpSecret.id, toolCount: tools.length });
            send({ type: "mcp.list", servers: mcpServerRepo.list().map((server) => ({ ...server, connected: mcp.isConnected(server.id), toolCount: mcp.toolCount(server.id) })) });
          } catch (error) {
            log.warn("MCP OAuth credential restore failed", { serverId: mcpSecret.id, err: String(error) });
          }
        }
      } else {
        runtimeSecrets.set(cmd.key, cmd.value);
        await adapter.setSecret(cmd.key, cmd.value);
      }
      send({ type: "secret.saved", requestId: cmd.requestId });
      return;
    }

    case "secret.delete":
      runtimeSecrets.delete(cmd.key);
      await adapter.deleteSecret(cmd.key);
      send({ type: "pong", requestId: cmd.requestId });
      if (cmd.key === "reach.xueqiu.cookie" || cmd.key === "reach.groq.apiKey") sendReachChannels();
      return;

    case "agent.run": {
      if (!cmd.goal) {
        const timer = goalContinuationTimers.get(cmd.sessionId);
        if (timer) { clearTimeout(timer); goalContinuationTimers.delete(cmd.sessionId); }
        const waitingGoal = goalRepo.getBySession(cmd.sessionId);
        if (waitingGoal?.status === "active" && waitingGoal.waitingReason) {
          const resumed = goalRepo.update(waitingGoal.id, { waitingReason: null, waitingUntil: null, stopReason: null, bumpEpoch: true });
          goalRepo.event(waitingGoal.id, cmd.sessionId, "resumed", { source: "user_input" });
          publishGoal(resumed);
        }
      }
      const s = sessionRepo.get(cmd.sessionId);
      if (!s) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown session ${cmd.sessionId}` });
        return;
      }
      if (!s.workspaceId) {
        send({ type: "error", requestId: cmd.requestId, message: "select a workspace before running the agent" });
        return;
      }
      if (cmd.mcpServerId && (!mcp.isConnected(cmd.mcpServerId) || mcp.toolCount(cmd.mcpServerId) === 0)) {
        send({ type: "error", requestId: cmd.requestId, message: "selected MCP server is not connected or has no tools" });
        return;
      }
      if (startingRunSessions.has(cmd.sessionId) || adapter.isRunning(cmd.sessionId) ||
          runRepo.listBySession(cmd.sessionId).some((run) => !subagentRunRepo.get(run.id) && ["created", "running", "waiting_approval", "paused"].includes(run.status))) {
        send({ type: "error", requestId: cmd.requestId, message: "session already has an active run" });
        return;
      }
      if (cmd.queueItemId) {
        queueRepo.remove(cmd.sessionId, cmd.queueItemId);
        sendQueue(cmd.sessionId);
      }
      if (!cmd.goalContinuation && !cmd.replaceFromMessageId) {
        cmd.replaceFromMessageId = repeatedUserMessageId(messageRepo.listBySession(cmd.sessionId).map(message => ({
          ...message,
          attachments: message.attachments ? JSON.parse(message.attachments) as MessageAttachmentInfo[] : undefined,
        })), { content: cmd.message, attachments: cmd.attachments });
      }
      if (cmd.replaceFromMessageId) {
        startingRunSessions.add(cmd.sessionId);
        try {
          const history = messageRepo.listBySession(cmd.sessionId);
          const index = history.findIndex(message => message.id === cmd.replaceFromMessageId && message.role === "user");
          if (index < 0) throw new Error("user message not found in session");
          const removedRunIds = new Set(history.slice(index).flatMap(message => message.runId ? [message.runId] : []));
          const childRuns = subagentRunRepo.listBySession(cmd.sessionId);
          for (let changed = true; changed;) {
            changed = false;
            for (const child of childRuns) if (removedRunIds.has(child.parentRunId) && !removedRunIds.has(child.runId)) {
              removedRunIds.add(child.runId);
              changed = true;
            }
          }
          await subagentController.dispose(cmd.sessionId, [...removedRunIds]);
          // Pi keeps an in-memory conversation; it must be rebuilt from the trimmed DB history.
          await adapter.disposeSession(cmd.sessionId);
          flushEvents();
          messageRepo.truncateFrom(cmd.sessionId, cmd.replaceFromMessageId);
          await generatedArtifacts.removeRuns(cmd.sessionId, [...removedRunIds]);
          eventJournal.restore(eventRepo.list());
        } catch (error) {
          send({ type: "error", requestId: cmd.requestId, ...runtimeErrorInfo(error) });
          return;
        } finally {
          startingRunSessions.delete(cmd.sessionId);
        }
      }
      const goal = cmd.goal ? goalRepo.getBySession(cmd.sessionId) : undefined;
      if (cmd.goal && (!goal || goal.status !== "active")) {
        send({ type: "error", requestId: cmd.requestId, message: "goal is not active" });
        return;
      }
      const run = runRepo.create(cmd.sessionId, {
        origin: goal ? (cmd.goalContinuation ? "goal_continuation" : "goal_kickoff") : "manual",
        goalId: goal?.id,
        goalEpoch: goal?.epoch,
      });
      assistantPartsByRun.set(run.id, []);
      liveAssistantByRun.set(run.id, { content: "", parts: [], sequence: 0 });
      const turn = turnRepo.create(run.id);
      if (!cmd.goalContinuation) {
        const userMessage = messageRepo.add(cmd.sessionId, "user", cmd.message, run.id, undefined, cmd.messageId, cmd.attachments, undefined, goal?.id, cmd.quote);
        touchSession(cmd.sessionId, userMessage.createdAt);
      }
      emit("agent.started", { runId: run.id }, cmd.sessionId, run.id);
      const workspaceCwd = s.workspaceId ? workspaceRepo.get(s.workspaceId)?.path : undefined;
      if (s.workspaceId && !workspaceCwd) {
        runRepo.finish(run.id, "failed", "session workspace no longer exists");
        assistantPartsByRun.delete(run.id);
        assistantMessageSequenceByRun.delete(run.id);
        liveAssistantByRun.delete(run.id);
        turnRepo.finish(turn.id, "failed");
        emit("agent.failed", { message: "session workspace no longer exists" }, cmd.sessionId, run.id);
        send({ type: "error", requestId: cmd.requestId, message: "session workspace no longer exists" });
        return;
      }

      const mcpCommand = cmd.mcpServerId ? parseMcpCommand(cmd.message) : undefined;
      const routedMessage = mcpCommand && mcpCommand.serverId === cmd.mcpServerId ? mcpCommand.text : cmd.message;
      const notificationDelivery = subagentNotificationCoordinator?.pendingPrompt(cmd.sessionId) ?? { ids: [] as string[], prompt: undefined };
      const modelMessage = [notificationDelivery.prompt, routedMessage].filter(Boolean).join("\n\n");
      Promise.resolve()
        .then(() => {
          subagentNotificationCoordinator?.markDelivered(notificationDelivery.ids);
          if (notificationDelivery.ids.length) sendSubagentNotifications(cmd.sessionId);
          return adapter.run(cmd.sessionId, modelMessage, { model: cmd.model, cwd: workspaceCwd, runId: run.id, eventSessionId: cmd.sessionId, permissionMode: cmd.permissionMode, thinking: cmd.thinking, attachments: cmd.attachments, mcpServerId: cmd.mcpServerId, goalId: goal?.id, goalEpoch: goal?.epoch }, (type, payload) =>
          emit(type, payload, cmd.sessionId, run.id)
        );
        })
        .then(async () => {
          const cancelled = cancelledRuns.delete(run.id);
          const parts = assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          if (!assistantMessage && !cancelled && !persistedAssistantRuns.has(run.id)) throw new Error("AI returned an empty response");
          releaseUndeliveredSteers(cmd.sessionId, run.id);
          persistedAssistantRuns.delete(run.id);
          initialUserMessageSeen.delete(run.id);
          assistantBuffers.delete(run.id);
          assistantStreamBuffers.delete(run.id);
          assistantPartsByRun.delete(run.id);
          assistantMessageSequenceByRun.delete(run.id);
          liveAssistantByRun.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const status = cancelled ? "cancelled" : "completed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status);
          touchSession(cmd.sessionId);
          if (goal) await adapter.disposeSession(cmd.sessionId);
          await releaseBrowserSession();
          emit(cancelled ? "agent.cancelled" : "agent.completed", assistantMessage ? {
            message: {
              id: assistantMessage.id,
              role: assistantMessage.role,
              content: assistantMessage.content,
              parts,
              runId: assistantMessage.runId,
              createdAt: assistantMessage.createdAt,
            },
          } : {}, cmd.sessionId, run.id);
          if (goal && !cancelled) {
            const current = goalRepo.get(goal.id);
            if (current?.status === "active" && !current.waitingReason && current.epoch === goal.epoch) scheduleGoalContinuation(cmd.sessionId, goal.id, goal.epoch);
          } else if (!goal && !cancelled) {
            const current = goalRepo.getBySession(cmd.sessionId);
            if (current?.status === "active" && !current.waitingReason) scheduleGoalContinuation(cmd.sessionId, current.id, current.epoch);
          }
        })
        .catch(async (err) => {
          if (notificationDelivery.ids.length) {
            subagentNotificationCoordinator?.markPending(notificationDelivery.ids);
            sendSubagentNotifications(cmd.sessionId);
          }
          const cancelled = cancelledRuns.delete(run.id);
          const parts = assistantPartsByRun.get(run.id) ?? [];
          const assistantMessage = persistPartialAssistant(cmd.sessionId, run.id, cmd.model);
          releaseUndeliveredSteers(cmd.sessionId, run.id);
          persistedAssistantRuns.delete(run.id);
          initialUserMessageSeen.delete(run.id);
          assistantBuffers.delete(run.id);
          assistantStreamBuffers.delete(run.id);
          assistantPartsByRun.delete(run.id);
          assistantMessageSequenceByRun.delete(run.id);
          liveAssistantByRun.delete(run.id);
          for (const key of toolCallIds.keys()) if (key.startsWith(`${run.id}:`)) toolCallIds.delete(key);
          const status = cancelled ? "cancelled" : "failed";
          turnRepo.finish(turn.id, status);
          runRepo.finish(run.id, status, cancelled ? undefined : String(err));
          touchSession(cmd.sessionId);
          if (goal) await adapter.disposeSession(cmd.sessionId);
          await releaseBrowserSession();
          emit(cancelled ? "agent.cancelled" : "agent.failed", cancelled
            ? (assistantMessage ? { message: { id: assistantMessage.id, role: assistantMessage.role, content: assistantMessage.content, parts, runId: assistantMessage.runId, createdAt: assistantMessage.createdAt } } : {})
            : runtimeErrorInfo(err), cmd.sessionId, run.id);
          if (goal && !cancelled) {
            const current = goalRepo.get(goal.id);
            if (current?.status === "active" && current.epoch === goal.epoch) {
              const updated = goalRepo.update(goal.id, { status: "blocked", stopReason: String(err) });
              goalRepo.event(goal.id, cmd.sessionId, "error", { error: String(err) }, run.id);
              publishGoal(updated);
            }
          }
        });

      send({ type: "pong", requestId: cmd.requestId });
      return;
    }

    case "agent.steer": {
      // Queue identity is the idempotency key, including when delivery won
      // the race against acknowledgement or a duplicate IPC request arrives.
      const delivered = () => messageRepo.hasUserMessage(cmd.sessionId, cmd.queueItemId);
      if (delivered() || pendingSteers.get(cmd.sessionId)?.some((item) => item.queueItemId === cmd.queueItemId)) {
        send({ type: "pong", requestId: cmd.requestId });
        return;
      }
      const session = sessionRepo.get(cmd.sessionId);
      if (!session || !adapter.isRunning(cmd.sessionId)) {
        send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.the_agent_is_no_longer_running_and_cannot_be") });
        return;
      }
      const activeRun = runRepo.listBySession(cmd.sessionId).find((run) => run.id === cmd.runId && ["created", "running", "waiting_approval", "paused"].includes(run.status));
      if (!activeRun) {
        send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.the_target_agent_run_has_ended") });
        return;
      }
      const pending = { runId: cmd.runId, queueItemId: cmd.queueItemId, message: cmd.message, attachments: cmd.attachments, quote: cmd.quote };
      const steers = pendingSteers.get(cmd.sessionId) ?? [];
      steers.push(pending);
      pendingSteers.set(cmd.sessionId, steers);
      let accepted = false;
      try {
        accepted = await adapter.sendToSession(cmd.sessionId, cmd.message, "steer", cmd.attachments, cmd.runId);
      } catch (error) {
        log.warn("steer rejected", { error: String(error), runId: cmd.runId });
      }
      if (!accepted && !delivered()) {
        const remaining = (pendingSteers.get(cmd.sessionId) ?? []).filter((item) => item !== pending);
        if (remaining.length) pendingSteers.set(cmd.sessionId, remaining);
        else pendingSteers.delete(cmd.sessionId);
        send({ type: "error", requestId: cmd.requestId, message: runtimeText("index.pi_is_not_accepting_steering_messages") });
        return;
      }
      // Acceptance only queues the steer inside Pi. The user turn enters the
      // transcript when Pi emits its message_end event.
      send({ type: "pong", requestId: cmd.requestId });
      return;
    }

    case "agent.stop": {
      const stoppedRun = runRepo.get(cmd.runId);
      if (!adapter.stop(cmd.runId)) {
        send({ type: "error", requestId: cmd.requestId, message: `unknown active run ${cmd.runId}` });
        return;
      }
      cancelledRuns.add(cmd.runId);
      if (stoppedRun) titleControllers.get(stoppedRun.sessionId)?.abort();
      if (stoppedRun?.goalId) {
        const goal = goalRepo.get(stoppedRun.goalId);
        if (goal?.status === "active") {
          const timer = goalContinuationTimers.get(stoppedRun.sessionId);
          if (timer) { clearTimeout(timer); goalContinuationTimers.delete(stoppedRun.sessionId); }
          const updated = goalRepo.update(goal.id, { status: "paused", waitingReason: null, waitingUntil: null, stopReason: "Paused by user", bumpEpoch: true });
          goalRepo.event(goal.id, stoppedRun.sessionId, "paused", { reason: "Paused by user" }, cmd.runId);
          publishGoal(updated);
        }
      }
      send({ type: "pong", requestId: cmd.requestId });
      return;
    }

    case "tool.approve":
      adapter.approve(cmd.approvalId);
      commandApprovals.approve(cmd.approvalId);
      if (approvalRuns.has(cmd.approvalId)) {
        const runId = approvalRuns.get(cmd.approvalId)!;
        runRepo.setStatus(runId, "running");
        const toolCallId = approvalToolCalls.get(cmd.approvalId);
        if (toolCallId) toolCallRepo.setStatus(toolCallId, "running");
        const run = runRepo.get(runId);
        if (run) emit("run.status", { status: "running" }, run.sessionId, runId);
      }
      approvalRuns.delete(cmd.approvalId);
      approvalToolCalls.delete(cmd.approvalId);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    case "tool.reject":
      adapter.reject(cmd.approvalId);
      commandApprovals.reject(cmd.approvalId);
      if (approvalRuns.has(cmd.approvalId)) {
        const runId = approvalRuns.get(cmd.approvalId)!;
        runRepo.setStatus(runId, "running");
        const toolCallId = approvalToolCalls.get(cmd.approvalId);
        if (toolCallId) toolCallRepo.setStatus(toolCallId, "running");
        const run = runRepo.get(runId);
        if (run) emit("run.status", { status: "running" }, run.sessionId, runId);
      }
      approvalRuns.delete(cmd.approvalId);
      approvalToolCalls.delete(cmd.approvalId);
      send({ type: "pong", requestId: cmd.requestId });
      return;

    default:
      send({
        type: "error",
        requestId: (cmd as { requestId?: string }).requestId,
        message: `unhandled command ${(cmd as { type: string }).type}`,
  });
}

function sendSubagentConfig(requestId?: string) {
  send({ type: "subagent.list", requestId, config: subagentConfig });
}
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
