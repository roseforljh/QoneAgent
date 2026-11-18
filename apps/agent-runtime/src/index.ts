import { connectMcp, registerMcp, mcpServerList, restoreMcpCredentials } from "./mcp-connections";
import { handleSessionCommand } from "./session-commands.js";
import { handleRuntimeCommand } from "./runtime-commands.js";
import { claudeMcpToken } from "./claude-code/mcp-auth";
import { sendMcpIcons } from "./mcp-icons";
import { prepareMcpConfiguration, watchConfiguration } from "./config-watch";
import { validateSettings } from "./config-validation";
import { configureBuiltinSkills } from "./builtin-skills/manager.js";
import { withRuntimeLocale, runtimeErrorInfo } from "./runtime-localization";
import { CompactionPositions } from "./compaction-position.js";
import { handleRuntimeEvent, NOT_REPLAYED, type RuntimeBusEvent } from "./runtime-event-subscriber.js";
import { SideConversationService } from "./side-conversation.js";

import { createLogger, EventBus, qoneDatabasePath, qoneSettingsPath, qoneStatePath, SequencedEventJournal } from "@qone/shared";
import type { RuntimeCommand, AgentEvent, AssistantMessagePart, SessionInfo, SubagentConfigInfo, GoalInfo, MessageAttachmentInfo, MessageQuoteInfo, AgentCommunicationInfo, SessionSearchResult, McpServerInfo } from "@qone/protocol";
import { decodeCommand, REMOVED_BUILTIN_SUBAGENT_IDS, serverOperationInfo, serverOperationCancelled } from "@qone/protocol";
import { openDb, ConfigFile, mcpServersFrom, SessionRepo, MessageRepo, RunRepo, GoalRepo, SubagentRunRepo, SubagentNotificationRepo, TurnRepo, WorkspaceRepo, ToolCallRepo, McpServerRepo, ModelConfigRepo, SettingsRepo, PreferencesRepo, QueueRepo, EventRepo, ArtifactRepo, PermissionRepo, SkillRepo } from "@qone/database";
import { McpManager } from "@qone/mcp";
import { DEFAULT_PI_COMPACTION_PREFERENCES, normalizePiCompactionPreferences, PiAdapter, type PiCompactionPreferences } from "./pi-adapter.js";
import { ApprovalQueue } from "./permissions.js";
import path from "node:path";
import { mkdirSync } from "node:fs";
import { GeneratedArtifacts } from "./generated-artifacts.js";
import { FileDelivery } from "./file-delivery.js";
import { ProjectResources } from "./project-resources.js";



import { ModelMetadataResolver } from "./model-resolver.js";
import { BrowserSyncService, createEmbeddedOpenCliRunner } from "./browser-sync.js";
import { createReachPublicTools } from "./reach-public-tools.js";
import { listReachChannels, ytDlpExecutable } from "./reach-channels.js";
import { podcastConfigured } from "./reach-podcast.js";
import { createPodcastTools } from "./reach-podcast-tools.js";
import { WebAccessMemory, type WebAccessObservation } from "./web-access-memory.js";


import { normalizeSubagentConfig } from "./subagents.js";
import { automaticCompactionBoundary, restoreCompactedContext, type SessionCompactionCheckpoint } from "./session-compaction.js";
import { registerSubagentDispatcher, subagentInfo } from "./subagent-runner.js";
import { createSubagentPublisher } from "./subagent-publisher.js";
import { SubagentNotificationCoordinator } from "./subagent-notifications.js";

import { ensureGlobalInstructions } from "./global-instructions.js";
import { ensureSystemPromptModules } from "./system-prompt.js";
import type { LiveAssistantState } from "./live-assistant.js";
import { createRuntimeOutput } from "./runtime-output.js";
import { DouyinBridge } from "./douyin-bridge.js";
import { AppMediaService } from "./app-media-service.js";
import { AppOpenCliBridge } from "./app-opencli-bridge.js";
import { MemoryStore } from "./memory/memory-store.js";
import { MemoryService } from "./memory/memory-service.js";
import { ServerService } from "./servers/server-service.js";

const log = createLogger("runtime");
// The desktop starts this process with Electron in Node mode. Never pass that
// mode on to user commands: any Electron app they launch would fail to open.
delete process.env.ELECTRON_RUN_AS_NODE;

const eventBus = new EventBus<RuntimeBusEvent>();

// NDJSON over stdio: one JSON object per line on stdout.
// stderr is reserved for logs.
const output = createRuntimeOutput({ write: (line) => { process.stdout.write(line); }, intervalMs: 8, maxEvents: 32 });
// Every MCP list update also delivers official icons, resolved in the background.
const send: typeof output.send = (event) => {
  output.send(event);
  if (event.type === "mcp.list") void sendMcpIcons(event.servers, stateRepo, output.send).catch((error) => log.warn("mcp icon resolution failed", { err: String(error) }));
};
const douyinBridge = new DouyinBridge((event) => send(event));
const appOpenCliBridge = new AppOpenCliBridge((event) => send(event));
const embeddedOpenCli = createEmbeddedOpenCliRunner(appOpenCliBridge);
const appMediaService = new AppMediaService();

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
// Configuration lives in editable JSON files; SQLite keeps only conversation and runtime data.
const settingsFile = new ConfigFile(qoneSettingsPath(), validateSettings);
const stateFile = new ConfigFile(qoneStatePath());
if (settingsFile.error) log.warn("settings.json is invalid; configuration changes wait until it is fixed", { err: settingsFile.error.message });
else {
  for (const section of ["mcpServers", "models", "permissions", "preferences"]) if (!settingsFile.read(section)) settingsFile.write(section, {});
}
const sessionRepo = new SessionRepo(db);
const messageRepo = new MessageRepo(db);
const runRepo = new RunRepo(db);
const goalRepo = new GoalRepo(db);
const subagentRunRepo = new SubagentRunRepo(db);
const subagentRunIds = new Set<string>();
const subagentNotificationRepo = new SubagentNotificationRepo(db);
const turnRepo = new TurnRepo(db);
const workspaceRepo = new WorkspaceRepo(db);
const toolCallRepo = new ToolCallRepo(db);
const mcpServerRepo = new McpServerRepo(settingsFile);
const modelConfigRepo = new ModelConfigRepo(settingsFile);
const runtimeSecrets = new Map<string, string>();
const settingsMetadataResolver = new ModelMetadataResolver();
const settingsRepo = new SettingsRepo(db);
const webAccessMemory = new WebAccessMemory(settingsRepo);
const preferencesRepo = new PreferencesRepo(settingsFile);
const stateRepo = new PreferencesRepo(stateFile, "cache");
configureBuiltinSkills(preferencesRepo);
const queueRepo = new QueueRepo(settingsRepo);
const sideConversations = new SideConversationService(db);
const isMemorySource = (sessionId: string) => !sideConversations.metadata(sessionId) && !subagentRunRepo.getByExecutionSession(sessionId);
// Late-bound adapter: server changes rebuild idle agent sessions so tool lists stay current.
const servers: ServerService = new ServerService(preferencesRepo, (event) => send(event), () => adapter.invalidateSessions());
const memory: MemoryService = new MemoryService({
  store: new MemoryStore(settingsRepo),
  source: {
    candidates: () => sessionRepo.list().filter((session) => isMemorySource(session.id))
      .map((session) => ({ id: session.id, title: session.title, updatedAt: session.updatedAt })),
    transcript: (sessionId) => messageRepo.listBySession(sessionId).map(({ role, content }) => ({ role, content })),
  },
  searchConversations: (query, excludeId) => sessionRepo.search(query, 20)
    .filter(({ session }) => session.id !== excludeId && isMemorySource(session.id))
    .map(({ session, content }) => ({ id: session.id, title: session.title, content: content ?? session.title })),
  // Late-bound: the adapter is created below and only called once a run starts.
  complete: (modelName) => (system, user, maxTokens): Promise<{ text: string; tokens: number }> => adapter.completeText(modelName, system, user, maxTokens),
  onChange: (state) => send({ type: "memory.state", state }),
  onError: (error) => log.warn("memory consolidation skipped", { err: String(error) }),
});
if (!settingsFile.error) {
  const enabled = preferencesRepo.get<boolean>("memory.enabled");
  if (enabled === undefined) preferencesRepo.set("memory.enabled", memory.store.settings().enabled);
  else memory.store.setEnabled(enabled);
}
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
// Files are referenced where the agent made them; events go through the shared bus.
const fileDelivery = new FileDelivery(artifactRepo, (type, payload, sessionId, runId) => emit(type, payload, sessionId, runId), (event) => send(event));
const permissionRepo = new PermissionRepo(settingsFile);
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
function publishSubagent(runId: string) {
  const status = runRepo.get(runId)?.status;
  if (status && ["created", "running", "waiting_approval", "paused"].includes(status)) subagentRunIds.add(runId);
  else subagentRunIds.delete(runId);
  subagentPublisher.publish(runId);
}
let eventFlushTimer: ReturnType<typeof setTimeout> | undefined;
let eventFlushRetry: { error: unknown; delayMs: number } | undefined;
const scheduleEventFlush = (delayMs: number) => eventFlushTimer = setTimeout(() => {
  eventFlushTimer = undefined;
  flushEvents();
}, delayMs);
const flushEvents = ({ required = false } = {}) => {
  // A busy event stream or repeated command must not bypass the retry delay.
  if (eventFlushTimer && eventFlushRetry) {
    if (required) throw eventFlushRetry.error;
    return;
  }
  clearTimeout(eventFlushTimer);
  eventFlushTimer = undefined;
  try {
    if (pendingEvents.length) {
      eventRepo.addMany(pendingEvents);
      pendingEvents.length = 0; // Only remove rows once the transaction commits.
    }
    // Transient events advance the sequence without a row. Persist their
    // watermark too, but never advance it ahead of the committed batch.
    settingsRepo.set("event.sequence", eventJournal.next);
    if (eventFlushRetry) log.info("event journal write recovered");
    eventFlushRetry = undefined;
  } catch (error) {
    if (!eventFlushRetry) log.warn("event journal write deferred", { err: String(error), pending: pendingEvents.length });
    const delayMs = eventFlushRetry ? Math.min(eventFlushRetry.delayMs * 2, 30_000) : 1_000;
    eventFlushRetry = { error, delayMs };
    scheduleEventFlush(delayMs).unref();
    if (required) throw error;
  }
};
const queueEventPersistence = (event: AgentEvent) => {
  pendingEvents.push(event);
  if (pendingEvents.length >= 50) flushEvents();
  else if (!eventFlushTimer) scheduleEventFlush(32);
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
  const approvalParent = busEvent.runId && (busEvent.type === "approval.requested" || busEvent.type === "approval.resolved") ? subagentRunRepo.get(busEvent.runId)?.parentSessionId : undefined;
  const replayEvent = eventJournal.record((sequence) => ({
    eventId: crypto.randomUUID(), sequence, type: busEvent.type,
    sessionId: approvalParent ?? busEvent.sessionId, runId: busEvent.runId,
    timestamp: Date.now(), payload: busEvent.type === "agent.completed" ? {} : busEvent.payload,
    scope: approvalParent ? "conversation" : childExecution ? "subagent" : "conversation",
  } satisfies AgentEvent), !NOT_REPLAYED.has(busEvent.type));
  const agentEvent = busEvent.type === "agent.completed" ? { ...replayEvent, payload: busEvent.payload } : replayEvent;
  handleRuntimeEvent({
    messageRepo, runRepo, subagentRunRepo, toolCallRepo, settingsRepo,
    assistantBuffers, assistantStreamBuffers, assistantPartsByRun, assistantRawMessagesByRun, assistantMessageSequenceByRun,
    liveAssistantByRun, subagentStreams, activeSubagents, subagentRunIds, initialUserMessageSeen,
    approvalRuns, approvalToolCalls, toolCallIds, compactionPositions,
    send: (event) => send(event as never), emit, flushEvents, touchSession, sendMessages, deliverSteer, queueEventPersistence,
    runRequiresSubagentFinalization,
    subagentConfig: () => subagentConfig,
    subagentController: () => subagentController,
    subagentNotificationCoordinator: () => subagentNotificationCoordinator,
    subagentPublisher,
  }, busEvent, agentEvent, childExecution);
});
const assistantBuffers = new Map<string, string>();
// Raw streamed deltas per run; survives aborts so partial answers can be saved.
const assistantStreamBuffers = new Map<string, string[]>();
const assistantPartsByRun = new Map<string, AssistantMessagePart[]>();
const assistantRawMessagesByRun = new Map<string, unknown[]>();
const assistantMessageSequenceByRun = new Map<string, number>();
const pendingSteers = new Map<string, Array<{ runId: string; queueItemId: string; message: string; attachments?: MessageAttachmentInfo[]; quote?: MessageQuoteInfo }>>();
const initialUserMessageSeen = new Set<string>();
const toolCallIds = new Map<string, string>();
const resolvedServerCalls = new Set<string>();
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
  return messageRepo.addAssistant(sessionId, content, runId, model, parts, undefined, assistantRawMessagesByRun.get(runId));
}

function deliverSteer(sessionId: string, runId: string, rawUser?: unknown) {
  const pending = pendingSteers.get(sessionId);
  if (!pending?.length || pending[0]?.runId !== runId) return;
  const steer = pending.shift()!;
  if (!pending.length) pendingSteers.delete(sessionId);
  const assistant = persistPartialAssistant(sessionId, runId);
  assistantBuffers.delete(runId);
  assistantStreamBuffers.delete(runId);
  assistantPartsByRun.set(runId, []);
  // The segment above already owns these raw messages; the next assistant row
  // starts a new segment instead of duplicating the transcript.
  assistantRawMessagesByRun.delete(runId);
  assistantMessageSequenceByRun.delete(runId);
  const live = liveAssistantByRun.get(runId);
  if (live) liveAssistantByRun.set(runId, { content: "", parts: [], sequence: live.sequence });
  const userMessage = messageRepo.add(sessionId, "user", steer.message, runId, undefined, steer.queueItemId, steer.attachments, undefined, undefined, steer.quote, rawUser);
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
  webAccessContext: (sessionId, task) => {
    const parse = (value: string | null) => {
      if (!value) return undefined;
      try { return JSON.parse(value); } catch { return undefined; }
    };
    const history: WebAccessObservation[] = toolCallRepo.listBySession(sessionId)
      .filter((call) => call.status === "success" || call.status === "failed")
      .map((call) => ({
        toolName: call.toolName,
        args: parse(call.arguments),
        result: parse(call.resultSummary),
        at: call.completedAt ?? call.startedAt ?? undefined,
      }));
    return webAccessMemory.context(sessionId, task, history);
  },
  memoryContext: (sessionId, message, modelName) => memory.context(sessionId, message, modelName),
  memoryTools: (sessionId) => memory.tools(sessionId),
  serverTools: (workspacePath, serverIds) => servers.tools(workspacePath, serverIds),
  deliveryTools: (sessionId, workspacePath, activeRunId) => [fileDelivery.tool(sessionId, workspacePath, activeRunId)],
  serverSummary: (serverIds) => servers.summary(serverIds),
  serverTargets: (serverIds) => servers.executionTargets(serverIds),
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
  onTool: (sessionId, runId, phase, name, args, result, toolCallId, parentToolCallId, durationMs) => {
    if (phase === "start") {
      const row = toolCallRepo.start(runId, name, args, toolCallId, parentToolCallId);
      if (toolCallId) toolCallIds.set(`${runId}:${toolCallId}`, row.id);
    } else if (phase === "update") {
      const operation = serverOperationInfo(result);
      const id = toolCallId && toolCallIds.get(`${runId}:${toolCallId}`);
      if (id && operation && !resolvedServerCalls.has(id)) {
        toolCallRepo.setServerOperation(id, operation);
        resolvedServerCalls.add(id);
      }
    } else {
      if (toolCallId) {
        const id = toolCallIds.get(`${runId}:${toolCallId}`);
        if (id) {
          const operation = serverOperationInfo(result);
          if (operation && !resolvedServerCalls.has(id)) toolCallRepo.setServerOperation(id, operation);
          resolvedServerCalls.delete(id);
          toolCallRepo.finish(id, serverOperationCancelled(result) ? "cancelled" : result && (result as { isError?: boolean }).isError ? "failed" : "success", result, durationMs);
          toolCallIds.delete(`${runId}:${toolCallId}`);
        }
      }
      webAccessMemory.recordToolResult(sessionId, name, args, result);
    }
  },
  onAutomaticCompaction: (sessionId, runId, context) => {
    const history = messageRepo.listBySession(sessionId);
    const boundary = automaticCompactionBoundary(history, runId, initialUserMessageSeen.has(runId), assistantRawMessagesByRun.get(runId)?.length ?? 0);
    if (!boundary) throw new Error("Could not locate the compacted session's history boundary");
    settingsRepo.set(`compaction:${sessionId}`, { ...boundary, context } satisfies SessionCompactionCheckpoint);
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
  // A running prompt already comes from adapter.run, not from its SQLite row.
  if (subagent) return subagentController.restoreMessages(subagent.runId);
  const history = messageRepo.listBySession(sessionId)
    .filter((message) => message.runId !== currentRunId)
    .map(({ id, role, content, runId, communication, attachments, rawMessage, createdAt }) => ({
      id, role, content, runId, communication, createdAt,
      attachments: attachments ? JSON.parse(attachments) : undefined,
      rawMessage: rawMessage ? JSON.parse(rawMessage) : undefined,
    }));
  const compacted = restoreCompactedContext(history, settingsRepo.get<SessionCompactionCheckpoint>(`compaction:${sessionId}`));
  const customEntries = settingsRepo.get<unknown[]>(`codemode.entries:${sessionId}`) ?? [];
  return [...compacted, ...customEntries.map((rawMessage) => ({ role: "custom", content: "", createdAt: Date.now(), rawMessage }))];
}, compactionPreferences, douyinBridge, appMediaService, embeddedOpenCli);
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
  appendParentMessage: (sessionId, runId, content, communication, rawMessage) => {
    messageRepo.add(sessionId, "user", content, runId, undefined, undefined, undefined, undefined, undefined, undefined, rawMessage, communication);
    sendMessages(sessionId);
  },
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
const modelsReady = adapter.configureModels(modelConfigRepo.list());
void modelsReady.catch((error) => log.warn("initial model configuration failed", { err: String(error) }));
const ensureModelsReady = () => modelsReady.then(() => adapter.configureModels(modelConfigRepo.list()));
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
// A one-time connection approval lives only with this exact configuration, never in settings.
const mcpConnectionApprovals = new Map<string, McpServerInfo>();
let browserSync: BrowserSyncService | undefined;
let browserReady: Promise<void> = Promise.resolve();

const mcp = new McpManager(async (serverId, token) => {
  const config = mcpServerRepo.list().find((server) => server.id === serverId);
  if (token) {
    const key = config?.oauth?.tokenSecretKey ?? `mcp.oauth:${serverId}`;
    runtimeSecrets.set(key, token);
    send({ type: "mcp.oauth.token", requestId: "oauth-callback", serverId, key, accessToken: token });
  }
  if (config && !config.disabled) {
    await mcp.disconnect(serverId);
    try {
      await connectMcp(config, runtimeCommandServices());
    } catch (error) {
      log.warn("MCP OAuth reconnect failed", { serverId, err: String(error) });
      const requestId = pendingMcpAuthRequests.get(serverId);
      if (requestId) send({ type: "error", requestId, ...runtimeErrorInfo(error) });
      pendingMcpAuthRequests.delete(serverId);
    }
  }
}, (serverId, kind, value) => {
  const key = `mcp.oauth:${serverId}.${kind}`;
  runtimeSecrets.set(key, value);
  send({ type: "mcp.oauth.credential", serverId, key, value });
}, (serverId, authorization) => {
  const requestId = pendingMcpAuthRequests.get(serverId);
  if (requestId) send({ type: "mcp.oauth.authorization", requestId, serverId, ...authorization });
}, (serverId, error) => {
  const requestId = pendingMcpAuthRequests.get(serverId);
  pendingMcpAuthRequests.delete(serverId);
  if (requestId) send({ type: "error", requestId, ...runtimeErrorInfo(error) });
}, (key) => runtimeSecrets.get(key), async (config) => {
  const key = config.oauth?.tokenSecretKey ?? `mcp.oauth:${config.id}`;
  runtimeSecrets.delete(key);
  send({ type: "mcp.oauth.invalidated", serverId: config.id, key });
  await refreshCustomTools();
  send({ type: "mcp.list", servers: mcpServerList({ mcp, mcpServerRepo, pendingMcpAuthRequests }) });
}, (config, credential) => {
  // Rotated tokens replace the persisted pair; the old refresh token is already spent.
  const key = config.oauth?.tokenSecretKey ?? `mcp.oauth:${config.id}`;
  runtimeSecrets.set(key, credential);
  send({ type: "mcp.oauth.token", requestId: "oauth-refresh", serverId: config.id, key, accessToken: credential });
}, async (serverId, kind) => {
  // The OAuth SDK rejected a stored credential. Delete the same key the
  // credential was saved under, otherwise every restart retries a dead
  // registration or a spent refresh token.
  const key = `mcp.oauth:${serverId}.${kind}`;
  runtimeSecrets.delete(key);
  send({ type: "mcp.oauth.invalidated", serverId, key });
}, claudeMcpToken, (config, signal) => restoreMcpCredentials(config, { send, runtimeSecrets, mcp }, signal), () => {
  send({ type: "mcp.list", servers: mcpServerList({ mcp, mcpServerRepo, pendingMcpAuthRequests }) });
}, {
  catalog: stateRepo,
  canConnect: id => {
    const decision = permissionRepo.get(`mcp:${id}`, "mcp.connect");
    const approved = mcpConnectionApprovals.get(id);
    return decision === "allow" || (decision === "ask" && !!approved && mcp.isRegistered(approved));
  },
  onAuthTargetChanged: config => {
    for (const key of [config.oauth?.tokenSecretKey ?? `mcp.oauth:${config.id}`, `mcp.oauth:${config.id}.client`, `mcp.oauth:${config.id}.tokens`]) {
      runtimeSecrets.delete(key);
      send({ type: "mcp.oauth.invalidated", serverId: config.id, key });
    }
  },
  onToolsChanged: () => { void refreshCustomTools().catch(error => log.warn("MCP tool refresh failed", { err: String(error) })); },
});
async function releaseBrowserSession() {
  if (adapter.getSessions().some(session => !session.isIdle)) return;
  try { await browserSync?.release(); }
  catch (error) { log.warn("browser session release failed", { err: String(error) }); }
}

async function refreshCustomTools() {
  await adapter.setCustomTools([
    ...mcp.tools(),
    ...createReachPublicTools({ ytDlp: ytDlpExecutable }),
    ...createPodcastTools(() => runtimeSecrets.get("reach.groq.apiKey"), embeddedOpenCli),
    ...(browserSync?.tools() ?? []),
  ]);
}

function sendReachChannels(requestId?: string) {
  send({ type: "reach.channels", requestId, channels: listReachChannels({
    browserConnected: browserSync?.status().targetConnected ?? false,
    mcpConnected: (id) => mcp.isAvailable(id),
    podcastConfigured: podcastConfigured(),
    hasGroqKey: Boolean(runtimeSecrets.get("reach.groq.apiKey")),
  }) });
}

async function initializeOptionalIntegrations() {
  browserSync = new BrowserSyncService(
    (status) => {
      send({ type: "browser.status", status });
      sendReachChannels();
    }, refreshCustomTools, appOpenCliBridge);
  browserReady = browserSync.initialize().catch((error) => {
    log.warn("browser initialization failed", { err: String(error) });
  });

  await Promise.all([...mcpServersFrom(settingsFile.read("mcpServers")), ...loadMcpConfigs()].map(async (entry: McpServerInfo) => {
    // OpenCLI owns the browser; Playwright is an explicitly enabled fallback.
    if (entry.id === "mcp-playwright" || entry.disabled) return;
    const stored = mcpServerRepo.list().some(server => server.id === entry.id);
    const subjectId = `mcp:${entry.id}`;
    permissionRepo.ensure(subjectId, "mcp.connect", "allow");
    if (permissionRepo.get(subjectId, "mcp.connect") !== "allow") return;
    try {
      const config = stored && (entry.env || entry.headers) ? await prepareMcpConfiguration(entry, runtimeCommandServices()) : entry;
      if (!config) return;
      await registerMcp(config, runtimeCommandServices());
      log.info("mcp registered", { serverId: config.id });
    } catch (err) {
      log.warn("mcp connection failed", { serverId: entry.id, err: String(err) });
    }
  }));
  await browserReady;
  await refreshCustomTools();
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
      communication: m.communication ? JSON.parse(m.communication) as AgentCommunicationInfo : undefined,
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

function scheduleGoalTask(sessionId: string, goalId: string, delay: number, task: () => void | Promise<void>) {
  if (goalContinuationTimers.has(sessionId)) return;
  const timer = setTimeout(() => {
    goalContinuationTimers.delete(sessionId);
    void Promise.resolve().then(task).catch((error) => {
      log.error("scheduled goal task failed", { sessionId, goalId, err: String(error) });
      send({ type: "error", ...runtimeErrorInfo(error) });
    });
  }, delay);
  goalContinuationTimers.set(sessionId, timer);
}

function scheduleGoalContinuation(sessionId: string, goalId: string, epoch: number) {
  scheduleGoalTask(sessionId, goalId, 0, () => {
    const goal = goalRepo.get(goalId);
    if (!goal || goal.sessionId !== sessionId || goal.status !== "active" || goal.epoch !== epoch || goal.waitingReason || queueRepo.list(sessionId).length > 0) return;
    const options = goalRepo.getOptions(goalId);
    return handle({
      type: "agent.run", requestId: crypto.randomUUID(), sessionId,
      message: `Continue working toward the goal. Inspect the current state, make the next useful changes, and call goal_complete only when the goal is fully verified. If a real blocker prevents progress, call goal_blocked with evidence.\n\nGoal: ${goal.objective}`,
      goal: true, goalContinuation: true, ...options,
    });
  });
}

function scheduleGoalWakeup(sessionId: string, goalId: string, reason: string, waitingUntil: number) {
  scheduleGoalTask(sessionId, goalId, Math.max(0, waitingUntil - Date.now()), () => {
    const current = goalRepo.get(goalId);
    if (!current || current.status !== "active" || current.waitingReason !== reason || current.waitingUntil !== waitingUntil) return;
    const resumed = goalRepo.update(goalId, { waitingReason: null, waitingUntil: null });
    goalRepo.event(goalId, sessionId, "resumed", { source: "wait_expired" });
    publishGoal(resumed);
    scheduleGoalContinuation(sessionId, goalId, resumed.epoch);
  });
}



function sendSubagentConfig(requestId?: string) {
  send({ type: "subagent.list", requestId, config: subagentConfig });
}

export function runtimeCommandServices() {
  return {
    adapter,
    memory,
    servers,
    ensureModelsReady,
    browserReady,
    approvalRuns,
    approvalToolCalls,
    artifactRepo,
    fileDelivery,
    assistantBuffers,
    assistantMessageSequenceByRun,
    assistantRawMessagesByRun,
    assistantPartsByRun,
    assistantStreamBuffers,
    authorizeCommand,
    get browserSync() { return browserSync; },
    set browserSync(value: typeof browserSync) { browserSync = value; },
    douyinBridge,
    appOpenCliBridge,
    appMediaService,
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
    mcpConnectionApprovals,
    messageRepo,
    modelConfigRepo,
    pendingMcpAuthRequests,
    pendingSteers,
    permissionRepo,
    preferencesRepo,
    stateRepo,
    settingsFile,
    persistPartialAssistant,
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

void initializeOptionalIntegrations().catch((error) => {
  log.error("optional integration initialization failed", { err: String(error) });
});
const stopConfigurationWatch = watchConfiguration(settingsFile, runtimeCommandServices);

// Read NDJSON commands from stdin.
const decoder = new TextDecoder();
let buf = "";
for await (const value of process.stdin as AsyncIterable<Uint8Array>) {
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

stopConfigurationWatch();
await mcp.disconnectAll();
for (const session of adapter.getSessions()) {
  try { await session.dispose(); } catch (error) { log.warn("Pi session dispose failed", { err: String(error) }); }
}
clearTimeout(eventFlushTimer);
eventFlushTimer = undefined;
flushEvents();
clearTimeout(eventFlushTimer);
if (eventFlushRetry) log.warn("event journal still not durable at shutdown", { err: String(eventFlushRetry.error), pending: pendingEvents.length });
subagentPublisher.dispose();
