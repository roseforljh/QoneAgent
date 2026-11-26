import { useMcpIcons } from "./lib/mcp-icons";
import { dispatchClaudeSync, dispatchClaudeSyncError, disconnectClaudeSync } from "./lib/claude-code-sync";
import { handleAgentEvent } from "./store/agent-events";
import { lastUserTurn } from "./lib/agent-communication";
import { translateCurrent as t } from "./localization";
import { localizeError } from "./lib/error-localization";
import { invoke, listen, openUrl } from "./lib/desktop-bridge";
import { mcpAvailable, assistantPartsFromPiMessage, applyAssistantToolEvent, applyReasoningDelta, type AssistantMessagePart, type ArtifactInfo, type CompactionMarkerInfo, type MessageInfo, type RunInfo, type RuntimeCommand, type RuntimeEvent, type SessionInfo } from "@qone/protocol";
import { DEFAULT_RUN_PERMISSION_MODE, saveNewSessionRunOptions, saveRunOptions, saveWorkspaceServerIds, withoutServers, withRunOptionDefaults } from "./lib/run-options";
import { reconcileServerOptions } from "./store/server-options";
import { getQoneMessageQueue, prunePausedQueues } from "./lib/qone-message-queue";
import { queueEditsOnDisconnect, sessionStore, switchSessionState } from "./lib/session-execution-state";
import { dispatchFilePreview, dispatchFilePreviewError, disconnectFilePreviews } from "./lib/file-preview-state";
import { dispatchMemoryError, dispatchMemoryState, resetMemoryRequests } from "./lib/memory-state";
import { dispatchExecutionStatsError, dispatchExecutionStatsState, resetExecutionStatsRequests } from "./lib/execution-stats-state";
import { dispatchServerError, dispatchServerEvent } from "./lib/server-state";
import { dispatchServerTerminal, dispatchServerTerminalError } from "./lib/server-terminal";
import {
  clearTrackedWorkspaceRequests,
  dispatchFileRead,
  dispatchWorkspaceError,
  dispatchWorkspaceFiles,
  dispatchWorkspaceGit,
  dispatchWorkspaceGitDiff,
} from "./lib/workspace-view-state";
import type { ToolCall } from "./store";
import { handleSideConversationEvent, retrySideConversationTransfers } from "./lib/side-conversation";
import { applySubagentPatch, applySubagentStreaming, mergeSubagentSnapshots, subagentActivity, updateSubagent } from "./lib/subagent-state";
import type { AgentState } from "./store";
import { runtimeEvents } from "./lib/runtime-event-payload";
import { douyinRequests, releaseAllAppOpenCliRequests, releaseAppOpenCliRequest, serveDouyinBridgeRequest, serveAppOpenCliRequest } from "./store/app-bridge";
import { restoreProviderProfilesFromModelConfigs } from "./lib/model-picker-data";
import { settleModelConfigSave } from "./lib/model-config-save";
import { handleFeatureEvent, resetFeatureRequests } from "./store/feature-events";
import { setTeamTransport, useTeamStore } from "./lib/team/store";
function subagentChange(state: AgentState, subagents: AgentState["subagents"], trackActivity: boolean): Partial<AgentState> {
  return subagents === state.subagents ? state : { subagents, ...(trackActivity ? subagentActivity(state, subagents) : {}) };
}

const rid = () => crypto.randomUUID();
const SUBAGENTS_STORAGE_KEY = "qone-subagents";
const CAPABILITY_ROUTING_STORAGE_KEY = "qone-capability-routing";
const SUBAGENT_RUNTIME_STORAGE_KEY = "qone-subagent-runtime";
function mergeSessionActivity(previous: SessionInfo, next: SessionInfo): SessionInfo {
  const lastUserMessageAt = Math.max(previous.lastUserMessageAt ?? 0, next.lastUserMessageAt ?? 0);
  return {
    ...next,
    updatedAt: Math.max(previous.updatedAt, next.updatedAt),
    ...(lastUserMessageAt > 0 ? { lastUserMessageAt } : {}),
  };
}
let wired = false;
let lastSequence = -1;
const lastRunSequences = new Map<string, number>();
export function initRuntimeBridge(dependencies: ReturnType<typeof import("./store").bridgeDependencies>) {
  const { useStore, hasDesktopBridge, clearDelta, flushNow, queueDelta, queueReasoning, deltas, pendingAgentRuns, stopRequestedSessionIds, forceStopRequestedSessionIds, stopRequests, pendingTitleRequests, pendingContextUsageRequests, mcpConnectRequests, metadataRequests, finishMcpConnection, handshakeRequests, steerRequests, workspaceRequests, cloudRequests, skillMutationRequests, browserUrlRequests, pendingMessageReplacements, pendingSessionMessageRequests, latestSessionMessageRequest, requestSessionMessages, clearSessionMessageRequests, stopRun, finishStopRequest, rememberBrowserConnection, browserAutoReconnectEnabled, displayRuntimeError, isCompactionMarker, alignToolCallIds, ensureStreamingToolPart, setMetadataLookupSupported } = dependencies;
  if (wired) return;
  if (!hasDesktopBridge() || typeof listen !== "function" || typeof invoke !== "function") return;
  wired = true;
  // 团队模式的全部写操作直连运行时：补齐 requestId 后经同一条运行时连接发送。
  setTeamTransport({ send: (command) => useStore.getState().send({ ...command, requestId: rid() } as RuntimeCommand) });

  const receive = (payload: RuntimeEvent | RuntimeEvent[] | string) => {
    for (const raw of runtimeEvents(payload)) {
      if (raw.type === "runtime.exited") {
      for (const controller of douyinRequests.values()) controller.abort();
      releaseAllAppOpenCliRequests();
      lastRunSequences.clear();
      for (const sessionId of deltas.keys()) clearDelta(sessionId);
      setMetadataLookupSupported(false);
      pendingAgentRuns.clear();
      stopRequestedSessionIds.clear();
      forceStopRequestedSessionIds.clear();
      stopRequests.clear();
      pendingTitleRequests.clear();
      pendingContextUsageRequests.clear();
      pendingSessionMessageRequests.clear();
      for (const request of browserUrlRequests.values()) request.reject(new Error(t("error.runtimeExited")));
      browserUrlRequests.clear();
      latestSessionMessageRequest.clear();
      mcpConnectRequests.clear();
      clearTrackedWorkspaceRequests();
      disconnectClaudeSync();
      disconnectFilePreviews();
      for (const request of metadataRequests.values()) request.reject(new Error(t("error.runtimeExited")));
      resetMemoryRequests(); resetExecutionStatsRequests(); resetFeatureRequests();
      useStore.setState((st) => {
        const userMessage = lastUserTurn(st.messages);
        return {
          connected: false,
          // Capabilities belong to one runtime process. Keeping them across a
          // restart can send a newly added optional command to an older
          // sidecar before its handshake completes.
          runtimeCapabilities: [],
          ...queueEditsOnDisconnect(st),
          runningSessionIds: [],
          subagentRunningSessionIds: [],
          completedSessionIds: [],
          compactionStatuses: {},
          autoCompactionStatuses: {},
          browserStatus: st.browserStatus ? { ...st.browserStatus, targetConnected: false, phase: "error", lastError: t("browser.runtimeExited") } : undefined,
          mcpConnectingIds: [],
          githubDeviceAuthorization: undefined,
          oauthAuthorization: undefined,
          running: false,
          titleGeneratingSessionIds: [],
          activeRunId: undefined,
          approvals: [],
          streaming: "",
          streamingParts: [],
          activeMessageSequence: undefined,
          preparedToolCallIds: [],
          messagesLoadingSessionId: undefined,
          contextUsageRequestId: undefined,
          queueItems: [],
          queueLoadedSessionId: undefined,
          ...(st.running && st.currentSessionId && userMessage ? {
            chatRunError: { sessionId: st.currentSessionId, userMessageId: userMessage.id, detail: t("error.runtimeExited") },
          } : {}),
        };
      });
      invoke("runtime_restart")
        .then(() => useStore.getState().send({ type: "ping", requestId: rid() }))
        .catch((error) => console.error("runtime restart failed", error));
      continue;
    }
    if (raw.type === "douyin.bridge.cancel") {
      douyinRequests.get(raw.requestId)?.abort();
      continue;
    }
    if (raw.type === "apps.opencli.release") {
      releaseAppOpenCliRequest(raw.requestId, Boolean(raw.close));
      continue;
    }
    if (raw.type === "apps.opencli.request") {
      void serveAppOpenCliRequest(raw, (command) => useStore.getState().send(command)).catch(() => undefined);
      continue;
    }
    if (raw.type === "douyin.bridge.request") {
      void serveDouyinBridgeRequest(raw, (command) => useStore.getState().send(command)).catch(() => undefined);
      continue;
    }
    const msg = raw;
    if (msg.type === "error" && msg.localization) msg.message = localizeError(msg);
    if (msg.type === "team.state" || msg.type === "team.message.append" || msg.type === "team.message.delta" || msg.type === "team.run.upsert" || msg.type === "team.bot.presence") {
      useTeamStore.getState().dispatchRuntimeEvent(msg);
      continue;
    }
    if (handleSideConversationEvent(msg) || handleFeatureEvent(msg)) continue;
    if (msg.type === "agent.event" && msg.event.scope === "subagent" && !msg.event.sourceSubagentId) {
      lastSequence = Math.max(lastSequence, msg.event.sequence);
      continue;
    }
    if (settleModelConfigSave(msg) && msg.type === "error") continue;
    if (msg.type === "model.metadata-resolved") {
      const pending = metadataRequests.get(msg.requestId);
      if (msg.models.every((model) => model.sources && ["contextWindow", "maxTokens", "reasoning", "input", "output"].every((field) => typeof model.sources[field as keyof typeof model.sources] === "string"))) pending?.resolve(msg.models);
      else pending?.reject(new Error("MODEL_METADATA_UNSUPPORTED"));
      continue;
    }
    if (msg.type === "error" && msg.requestId && metadataRequests.has(msg.requestId)) {
      metadataRequests.get(msg.requestId)?.reject(new Error(msg.message));
      continue;
    }
    if (msg.type === "error" && msg.requestId) {
      const ownerId = pendingContextUsageRequests.get(msg.requestId);
      if (ownerId) {
        pendingContextUsageRequests.delete(msg.requestId);
        sessionStore(useStore, ownerId).setState((state) => state.contextUsageRequestId === msg.requestId
          ? { contextUsageRequestId: undefined } : state);
        continue;
      }
    }
    const targetSessionId = msg.type === "agent.event" ? msg.event.sessionId
      : "sessionId" in msg && msg.type !== "session.deleted" ? msg.sessionId
      : "subagent" in msg ? msg.subagent.parentSessionId
      : msg.type === "goal.updated" ? msg.goal.sessionId
      : msg.type === "error" && msg.requestId ? pendingAgentRuns.get(msg.requestId)?.sessionId ?? stopRequests.get(msg.requestId)?.sessionId
      : undefined;
    const eventStore = sessionStore(useStore, targetSessionId);
    const s = eventStore.getState();
    switch (msg.type) {
      case "pong":
        if (msg.compaction) useStore.setState(msg.compaction);
        if (stopRequests.has(msg.requestId)) break;
        if (steerRequests.has(msg.requestId)) {
          steerRequests.get(msg.requestId)?.resolve(true);
          break;
        }
        if (pendingAgentRuns.has(msg.requestId)) {
          const { sessionId } = pendingAgentRuns.get(msg.requestId)!;
          // A pong only acknowledges that runtime_send accepted the command;
          // it does not confirm that the user turn is durable yet.
          requestSessionMessages(sessionId);
          void s.send({ type: "session.runs", requestId: rid(), sessionId });
          break;
        }
        if (!handshakeRequests.delete(msg.requestId)) break;
        setMetadataLookupSupported(Boolean(msg.capabilities?.includes("model.resolve-metadata") && msg.capabilities?.includes("model.metadata-sources")));
        eventStore.setState({ connected: true, runtimeCapabilities: msg.capabilities ?? [], ...(msg.compaction ?? {}) });
        retrySideConversationTransfers();
        s.send({ type: "session.list", requestId: rid() });
        s.send({ type: "workspace.list", requestId: rid() });
        s.send({ type: "model.list", requestId: rid() });
        s.send({ type: "mcp.list", requestId: rid() });
        s.send({ type: "subagent.list", requestId: rid() });
        if (msg.capabilities?.includes("reach.channels")) s.send({ type: "reach.channels", requestId: rid() });
        if (msg.capabilities?.includes("browser.connect")) {
          s.send({ type: "browser.status", requestId: rid() });
          if (browserAutoReconnectEnabled()) {
            void s.send({ type: "browser.connect", requestId: rid() });
          }
        }
        s.send({ type: "permission.list", requestId: rid() });
        s.send({ type: "global-prompt.get", requestId: rid() });
        s.send({ type: "servers.list", requestId: rid() });
        s.send({ type: "team.state.get", requestId: rid() });
        s.send({ type: "events.replay", requestId: rid(), sessionId: eventStore.getState().currentSessionId, afterSequence: lastSequence });
        break;
      case "memory.state":
        dispatchMemoryState(msg);
        break;
      case "stats.state":
        dispatchExecutionStatsState(msg);
        break;
      case "servers.state": {
        const liveIds = new Set(msg.servers.map(server => server.id));
        useStore.setState(state => reconcileServerOptions(state, liveIds));
        dispatchServerEvent(msg);
        break;
      }
      case "servers.setup":
      case "servers.discovered":
        dispatchServerEvent(msg);
        break;
      case "server.terminal.data":
      case "server.terminal.exit":
      case "server.terminal.opened":
        dispatchServerTerminal(msg);
        break;
      case "claude-code.synced":
        dispatchClaudeSync(msg);
        break;
      case "global-prompt":
        eventStore.setState({ globalPrompt: msg.content, globalPromptPath: msg.path, globalPromptDirectory: msg.directory, globalPromptLoaded: true });
        break;
      case "session.created":
        flushNow();
        eventStore.setState((st) => {
          const modelId = st.draftRunOptions.modelId
            ?? (st.creatingSession ? st.selectedModelId : undefined)
            ?? st.modelConfigs.find((model) => model.enabled)?.id;
          const newSessionDefaults = {
            ...st.draftRunOptions,
            ...(modelId ? { modelId } : {}),
            ...(!st.draftRunOptions.permissionMode ? { permissionMode: DEFAULT_RUN_PERMISSION_MODE } : {}),
          };
          // Snapshot the draft selection, including an explicit empty selection,
          // without carrying servers over from a draft in another project.
          const stored = st.runOptionsBySession[msg.session.id];
          const workspaceId = msg.session.workspaceId;
          const serverIds = stored?.serverIds ?? (workspaceId && (st.draftWorkspaceId === workspaceId
            ? st.draftRunOptions.serverIds
            : st.workspaceServerIds[workspaceId]));
          const sessionRunOptions = { ...withRunOptionDefaults(stored, newSessionDefaults), ...(serverIds ? { serverIds: [...serverIds] } : {}) };
          return {
            runOptionsBySession: { ...st.runOptionsBySession, [msg.session.id]: sessionRunOptions },
            selectedModelId: sessionRunOptions.modelId ?? st.selectedModelId,
            draftRunOptions: withoutServers(st.draftRunOptions),
            sessions: [msg.session, ...st.sessions],
            currentSessionId: msg.session.id,
            currentWorkspaceId: msg.session.workspaceId ?? st.currentWorkspaceId,
            draftWorkspaceId: undefined,
            messagesLoadingSessionId: undefined,
            messages: [],
            compactions: [],
            streaming: "",
            streamingParts: [],
            activeMessageSequence: undefined,
            preparedToolCallIds: [],
            toolCalls: [],
            runs: [],
            subagents: [],
            subagentNotifications: [],
            artifacts: [],
            running: false,
            activeRunId: undefined,
            modelRequest: undefined,
            approvals: [],
            ...switchSessionState(st, msg.session.id),
            // A newly created conversation has no persisted queue. Establish
            // that baseline before it can send queue.sync; its first echo is
            // an acknowledgement, not a snapshot to restore over local work.
            queueItems: [],
            queueLoadedSessionId: msg.session.id,
            editingQueueItem: undefined,
          };
        });
        saveRunOptions(eventStore.getState().runOptionsBySession);
        if (eventStore.getState().creatingSession && eventStore.getState().pendingMessage !== undefined) {
          queueMicrotask(() => {
            const state = eventStore.getState();
          if (state.currentSessionId === msg.session.id && state.pendingMessage !== undefined) state.runAgent(state.pendingMessage, undefined, state.pendingAttachments, undefined, state.pendingGoal, msg.session.id, state.pendingQuote, undefined, state.pendingServerIds);
          });
        }
        break;
      case "session.deleted":
      case "session.list": {
        const state = eventStore.getState();
        const cur = state.currentSessionId;
        const deletedId = msg.type === "session.deleted" ? msg.sessionId : undefined;
        const sessions = msg.type === "session.list" ? msg.sessions
          : state.sideChats[msg.sessionId] ? state.sessions : state.sessions.filter((session) => session.id !== msg.sessionId);
        const sideChats = msg.type === "session.list" ? msg.sideChats
          : state.sideChats[msg.sessionId] ? Object.values(state.sideChats).filter((session) => session.id !== msg.sessionId) : undefined;
        const reload = msg.type === "session.list" || deletedId === cur;
        const selected = reload ? sessions.find((session) => session.id === cur) ?? sessions[0] : undefined;
        const selectionChanged = reload && selected?.id !== cur;
        if (deletedId) {
          clearDelta(deletedId);
          clearSessionMessageRequests(deletedId);
        }
        if (selectionChanged) flushNow();
        const storedOptions = selected ? state.runOptionsBySession[selected.id] : undefined;
        const needsDefaults = Boolean(selected && (!storedOptions?.modelId || !storedOptions?.permissionMode));
        const selectedOptions = selected && needsDefaults
          ? withRunOptionDefaults(storedOptions, state.draftRunOptions)
          : storedOptions;
        const runOptionsBySession = selected && selectedOptions && needsDefaults
          ? { ...state.runOptionsBySession, [selected.id]: selectedOptions }
          : state.runOptionsBySession;
        // Prune after computing the switch, so a deleted selection isn't cached again.
        const liveIds = deletedId ? undefined : new Set([
          ...sessions.map((session) => session.id),
          ...(sideChats ?? Object.values(state.sideChats)).map((session) => session.id),
        ]);
        const isLive = (id: string) => liveIds ? liveIds.has(id) : id !== deletedId;
        prunePausedQueues(isLive);
        const switchState = selectionChanged ? switchSessionState(state, selected?.id) : undefined;
        const cachedIds = Object.keys(switchState?.backgroundSessions ?? state.backgroundSessions);
        const staleIds = cachedIds.filter((id) => !isLive(id));
        const backgroundSessions = staleIds.length === 0 ? undefined
          : Object.fromEntries(Object.entries((switchState?.backgroundSessions ?? state.backgroundSessions))
              .filter(([id]) => isLive(id)));
        const staleOptions = Object.keys(runOptionsBySession).filter((id) => !isLive(id));
        const prunedRunOptions = staleOptions.length === 0 ? runOptionsBySession
          : Object.fromEntries(Object.entries(runOptionsBySession).filter(([id]) => isLive(id)));
        eventStore.setState({
          sessions,
          ...(state.subagentRunningSessionIds.some((id) => !isLive(id))
            ? { subagentRunningSessionIds: state.subagentRunningSessionIds.filter(isLive) } : {}),
          ...(sideChats ? { sideChats: Object.fromEntries(sideChats.map((session) => [session.id, session])) } : {}),
          ...(deletedId ? {
            ...(state.runningSessionIds.includes(deletedId) ? { runningSessionIds: state.runningSessionIds.filter(isLive) } : {}),
            ...(state.completedSessionIds.includes(deletedId) ? { completedSessionIds: state.completedSessionIds.filter(isLive) } : {}),
            ...(state.searchResults.some((result) => result.session.id === deletedId)
              ? { searchResults: state.searchResults.filter((result) => isLive(result.session.id)) } : {}),
          } : { sessionsLoaded: true }),
          ...(reload ? {
            currentSessionId: selected?.id,
            currentWorkspaceId: selected?.workspaceId ?? state.currentWorkspaceId,
            ...(selected?.workspaceId && selected.workspaceId !== state.currentWorkspaceId ? { workspaceLoadingId: selected.workspaceId } : {}),
            selectedModelId: selectedOptions?.modelId ?? (state.modelConfigs.some((config) => config.id === state.selectedModelId) ? state.selectedModelId : undefined),
          } : {}),
          runOptionsBySession: prunedRunOptions,
          ...(selectionChanged ? {
            messages: [],
            compactions: [],
            messagesLoadingSessionId: selected?.id,
             queueItems: [],
             queueLoadedSessionId: undefined,
             editingQueueItem: undefined,
            streaming: "",
            streamingParts: [],
            activeMessageSequence: undefined,
            preparedToolCallIds: [],
            toolCalls: [],
            runs: [],
            subagents: [],
            subagentNotifications: [],
            artifacts: [],
            ...switchState,
          } : {}),
          ...(backgroundSessions ? { backgroundSessions } : {}),
        });
        if (needsDefaults || staleOptions.length) saveRunOptions(prunedRunOptions);
        if (selected) {
          requestSessionMessages(selected.id);
          s.send({ type: "goal.get", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.queue.list", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.toolCalls", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.runs", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.subagents", requestId: rid(), sessionId: selected.id });
          if (eventStore.getState().runtimeCapabilities.includes("subagent.notifications")) {
            s.send({ type: "session.subagentNotifications", requestId: rid(), sessionId: selected.id });
          }
          s.send({ type: "artifact.list", requestId: rid(), sessionId: selected.id });
          if (selected.workspaceId) eventStore.getState().refreshWorkspace(selected.workspaceId);
        }
        break;
      }
      case "session.updated":
        eventStore.setState((st) => msg.session.sideChat
          ? { sideChats: { ...st.sideChats, [msg.session.id]: msg.session } }
          : { sessions: st.sessions.map((session) => session.id === msg.session.id
              ? mergeSessionActivity(session, msg.session) : session) });
        break;
      case "session.search":
        if (msg.query === eventStore.getState().activeSearchQuery) eventStore.setState({ searchResults: msg.results, searchLoading: false });
        break;
      case "session.renamed":
        for (const [requestId, sessionId] of pendingTitleRequests) {
          if (sessionId === msg.session.id) pendingTitleRequests.delete(requestId);
        }
        eventStore.setState((st) => ({
          sessions: st.sessions.map((session) => session.id === msg.session.id
            ? mergeSessionActivity(session, msg.session) : session),
          titleGeneratingSessionIds: st.titleGeneratingSessionIds.filter((id) => id !== msg.session.id),
        }));
        break;
      case "session.messages": {
        const pendingRequest = msg.requestId ? pendingSessionMessageRequests.get(msg.requestId) : undefined;
        const requestSessionId = pendingRequest?.sessionId ?? msg.sessionId;
        const isLatestRequest = !msg.requestId || latestSessionMessageRequest.get(requestSessionId) === msg.requestId;
        if (msg.requestId && !pendingRequest) break;
        if (msg.requestId) {
          pendingSessionMessageRequests.delete(msg.requestId);
          if (isLatestRequest) latestSessionMessageRequest.delete(requestSessionId);
        }
        // A response to an older history query must never replace the current
        // conversation snapshot. The request id is the only ordering signal
        // that survives the runtime IPC boundary.
        if (!isLatestRequest) break;
        const savedMessages = new Map(msg.messages.map(message => [message.id, message]));
        const savedMessageIds = new Set(savedMessages.keys());
        for (const pending of pendingAgentRuns.values()) {
          if (pending.sessionId !== msg.sessionId) continue;
          const saved = savedMessages.get(pending.userMessageId);
          if (!saved?.runId) continue;
          const wasUnbound = !pending.runId;
          pending.runId = saved.runId;
          if (pending.queueItemId) getQoneMessageQueue(msg.sessionId)?.settleSend(pending.queueItemId, true);
          if (wasUnbound) void s.send({ type: "session.runs", requestId: rid(), sessionId: msg.sessionId });
        }
        for (const [requestId, pending] of pendingAgentRuns) {
          // A run may produce an up-to-date snapshot before an older in-flight
          // query returns. Do not drop the protection until the run is over;
          // otherwise that older snapshot can remove the newest user bubble.
          if (pending.sessionId === msg.sessionId && pending.completed && savedMessageIds.has(pending.userMessageId)) {
            pendingAgentRuns.delete(requestId);
          }
        }
        if (msg.sessionId === eventStore.getState().currentSessionId) {
          const replacedMessageId = pendingMessageReplacements.get(msg.sessionId);
          if (replacedMessageId && msg.messages.some((message) => message.id === replacedMessageId)) {
            clearSessionMessageRequests(msg.sessionId);
            eventStore.setState((state) => state.messagesLoadingSessionId === msg.sessionId ? { messagesLoadingSessionId: undefined } : state);
            break;
          }
          if (replacedMessageId) pendingMessageReplacements.delete(msg.sessionId);
          clearSessionMessageRequests(msg.sessionId);
          const messages = msg.messages.map((m: MessageInfo) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            quote: m.quote,
            persisted: true,
            parts: m.parts,
            attachments: m.attachments,
            runId: m.runId,
            createdAt: m.createdAt,
            goalId: m.goalId,
            communication: m.communication,
          }));
          const queue = getQoneMessageQueue(msg.sessionId);
          const deliveredSteer = messages.some((message) => message.role === "user"
            && message.runId === eventStore.getState().activeRunId
            && queue?.adapter.steerItems.some((item) => queue.getPersistentId(item.id) === message.id));
          if (deliveredSteer) clearDelta(msg.sessionId);
          const live = msg.streaming && msg.streaming.sequence >= (lastRunSequences.get(msg.streaming.runId) ?? -1)
            ? msg.streaming : undefined;
          if (live) {
            clearDelta(msg.sessionId);
            lastRunSequences.set(live.runId, live.sequence);
          }
          eventStore.setState((st) => {
            const pendingIds = new Set([...pendingAgentRuns.values()].filter((pending) => pending.sessionId === msg.sessionId).map((pending) => pending.userMessageId));
            if (st.chatRunError) pendingIds.add(st.chatRunError.userMessageId);
            // A long history must not compare every live row against every
            // saved row; one id set makes the merge linear.
            const savedIds = new Set(messages.map((message) => message.id));
            const merged = pendingIds.size === 0 ? messages
              : [...messages, ...st.messages.filter((message) => pendingIds.has(message.id) && !savedIds.has(message.id))];
            return { messagesLoadingSessionId: undefined, messages: merged, compactions: msg.compactions ?? [], toolCalls: alignToolCallIds(st.toolCalls, merged),
              ...(live ? {
                streaming: live.content,
                streamingParts: live.parts,
                activeMessageSequence: live.messageSequence,
                activeRunId: live.runId,
                running: true,
                runningSessionIds: st.runningSessionIds.includes(msg.sessionId) ? st.runningSessionIds : [...st.runningSessionIds, msg.sessionId],
              } : {}),
              ...(deliveredSteer ? { streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [] } : {}),
            };
          });
        }
        break;
      }
      case "goal.current":
        if (msg.sessionId === eventStore.getState().currentSessionId) eventStore.setState({ goal: msg.goal });
        break;
      case "goal.updated":
        if (msg.goal.sessionId === eventStore.getState().currentSessionId) eventStore.setState({ goal: msg.goal });
        break;
      case "goal.cleared":
        if (msg.sessionId === eventStore.getState().currentSessionId) eventStore.setState({ goal: undefined });
        break;
      case "session.queue":
        if (msg.sessionId === eventStore.getState().currentSessionId) eventStore.setState({ queueItems: msg.items, queueLoadedSessionId: msg.sessionId });
        break;
      case "session.toolCalls":
        if (msg.sessionId === eventStore.getState().currentSessionId) {
          eventStore.setState((st) => {
            const calls = msg.toolCalls.map((t) => ({
                toolCallId: t.id.startsWith(`${t.runId}:`) ? t.id.slice(t.runId.length + 1) : t.id,
                runId: t.runId, toolName: t.toolName, parentToolCallId: t.parentToolCallId, serverOperation: t.serverOperation, sourceSubagentId: t.sourceSubagentId,
                status: t.status === "cancelled" ? "cancelled" : t.status === "failed" ? "failed" : t.status === "running" ? "running" : t.status === "waiting_approval" ? "waiting" : "success",
                args: (() => { try { return t.arguments ? JSON.parse(t.arguments) : undefined; } catch { return undefined; } })(),
                argsText: t.arguments ?? undefined,
                result: (() => { try { return t.resultSummary ? JSON.parse(t.resultSummary) : undefined; } catch { return t.resultSummary; } })(),
                summary: t.resultSummary,
                startedAt: t.startedAt,
                completedAt: t.completedAt,
                durationMs: t.durationMs,
              } satisfies ToolCall));
            const live = new Map(st.toolCalls.filter((call) => call.runId === st.activeRunId || Boolean(call.sourceSubagentId) && (call.status === "running" || call.status === "waiting")).map((call) => [call.toolCallId, call]));
            const merged = calls.map((call) => live.get(call.toolCallId) ?? call);
            const mergedIds = new Set(merged.map((call) => call.toolCallId));
            for (const call of live.values()) if (!mergedIds.has(call.toolCallId)) merged.push(call);
            return { toolCalls: alignToolCallIds(merged, st.messages) };
          });
        }
        break;
      case "session.runs":
        {
          const activeRun = msg.runs.find((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status));
          for (const pending of pendingAgentRuns.values()) {
            if (pending.sessionId !== msg.sessionId || !pending.runId || pending.completed) continue;
            const run = msg.runs.find(run => run.id === pending.runId);
            if (run && !["created", "running", "waiting_approval", "paused"].includes(run.status)) pending.completed = true;
          }
          eventStore.setState((st) => {
            // A completed run may still be waiting for its history snapshot to
            // persist the optimistic user message. That persistence wait must
            // not keep the conversation marked as running.
            const pending = [...pendingAgentRuns.values()].some((request) => request.sessionId === msg.sessionId && !request.completed);
            const runningSessionIds = activeRun || pending || (st.running && st.activeRunId && !msg.runs.some((run) => run.id === st.activeRunId))
              ? st.runningSessionIds.includes(msg.sessionId) ? st.runningSessionIds : [...st.runningSessionIds, msg.sessionId]
              : st.runningSessionIds.filter((id) => id !== msg.sessionId);
            if (msg.sessionId !== st.currentSessionId) return { runningSessionIds };
            return {
              runningSessionIds,
              runs: msg.runs,
              ...(activeRun
                ? { running: true, activeRunId: activeRun.id }
                // A snapshot requested before a queued agent.run reached the
                // runtime cannot see that run yet; only clear a run nobody started.
                : !pending && (!st.activeRunId || msg.runs.some((run) => run.id === st.activeRunId))
                  ? { running: false, activeRunId: undefined }
                  : {}),
            };
          });
          if (activeRun && stopRequestedSessionIds.has(msg.sessionId)) {
            sessionStore(useStore, msg.sessionId).setState({ stoppingRunId: activeRun.id });
            stopRun(msg.sessionId, activeRun.id, forceStopRequestedSessionIds.has(msg.sessionId));
          } else if (!eventStore.getState().running) finishStopRequest(msg.sessionId);
        }
        break;
      case "session.subagents":
        eventStore.setState((st) => subagentChange(st, mergeSubagentSnapshots(st.subagents, msg.subagents), true));
        break;
      case "session.subagentNotifications":
        if (msg.sessionId === eventStore.getState().currentSessionId) eventStore.setState({ subagentNotifications: msg.notifications });
        break;
      case "background-shell.job":
        eventStore.setState((st) => ({ backgroundJobs: st.backgroundJobs.some((job) => job.id === msg.job.id)
          ? st.backgroundJobs.map((job) => job.id === msg.job.id ? msg.job : job) : [...st.backgroundJobs, msg.job] }));
        break;
      case "background-shell.jobs":
        eventStore.setState((st) => ({ backgroundJobs: [...st.backgroundJobs.filter((job) => job.sessionId !== msg.sessionId), ...msg.jobs] }));
        break;
      case "subagent.patch":
        eventStore.setState((st) => subagentChange(st, updateSubagent(st.subagents, msg.id, (current) => applySubagentPatch(current, msg.patch)), msg.patch.status !== undefined));
        break;
      case "subagent.streaming":
        eventStore.setState((st) => subagentChange(st, updateSubagent(st.subagents, msg.id, (current) => applySubagentStreaming(current, msg)), false));
        break;
      case "subagent.updated":
      case "subagent.query":
      case "subagent.controlled":
        eventStore.setState((st) => subagentChange(st, mergeSubagentSnapshots(st.subagents, [msg.subagent]), true));
        break;
      case "artifact.list":
        if (msg.sessionId === eventStore.getState().currentSessionId) eventStore.setState({ artifacts: msg.artifacts });
        break;
      case "artifact.deleted":
        if (msg.sessionId === eventStore.getState().currentSessionId) {
          eventStore.setState((st) => ({ artifacts: st.artifacts.filter((artifact) => artifact.id !== msg.artifactId) }));
        }
        break;
      case "workspace.list": {
        eventStore.setState({ workspaces: msg.workspaces, workspacesLoaded: true });
        const current = eventStore.getState().currentWorkspaceId;
        const selected = current && msg.workspaces.some((workspace) => workspace.id === current) ? current : msg.workspaces[0]?.id;
        if (selected) {
          eventStore.setState({ currentWorkspaceId: selected, workspaceLoadingId: selected, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined });
          eventStore.getState().refreshWorkspace(selected);
        }
        break;
      }
      case "workspace.updated":
        flushNow();
        eventStore.setState((st) => ({
          workspaces: [msg.workspace, ...st.workspaces.filter((w) => w.id !== msg.workspace.id)],
          currentWorkspaceId: msg.workspace.id,
          workspaceLoadingId: msg.workspace.id,
          workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined,
        }));
        eventStore.getState().newSessionInWorkspace(msg.workspace.id);
        break;
      case "workspace.renamed":
        eventStore.setState((st) => ({ workspaces: st.workspaces.map((workspace) => workspace.id === msg.workspace.id ? msg.workspace : workspace) }));
        break;
      case "workspace.deleted":
        if (eventStore.getState().currentWorkspaceId === msg.workspaceId) clearDelta();
        eventStore.setState((st) => {
          const workspaces = st.workspaces.filter((workspace) => workspace.id !== msg.workspaceId);
          const wasCurrent = st.currentWorkspaceId === msg.workspaceId;
          const nextWorkspaceId = wasCurrent ? workspaces[0]?.id : st.currentWorkspaceId;
          let workspaceServerIds = st.workspaceServerIds;
          if (Object.hasOwn(workspaceServerIds, msg.workspaceId)) {
            workspaceServerIds = { ...workspaceServerIds };
            delete workspaceServerIds[msg.workspaceId];
            saveWorkspaceServerIds(workspaceServerIds);
          }
          return {
            workspaces,
            workspaceServerIds,
            currentWorkspaceId: nextWorkspaceId,
            ...(wasCurrent ? { currentSessionId: undefined, workspaceLoadingId: nextWorkspaceId, workspaceFiles: [], gitStatus: "", gitEntries: [], gitLoaded: false, openFile: undefined, gitDiffView: undefined, workspaceError: undefined, messagesLoadingSessionId: undefined, draftWorkspaceId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], compactions: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], subagents: [], artifacts: [], approvals: [] } : {}),
          };
        });
        if (eventStore.getState().currentWorkspaceId) eventStore.getState().refreshWorkspace();
        s.send({ type: "session.list", requestId: rid() });
        break;
      case "workspace.files": {
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        const { shouldUpdateGlobal } = dispatchWorkspaceFiles(msg, eventStore.getState().currentWorkspaceId);
        if (shouldUpdateGlobal) {
          eventStore.setState((st) => ({
            workspaceFiles: [
              ...st.workspaceFiles.filter((file) => msg.path
                ? !file.path.startsWith(`${msg.path}/`)
                : !file.path.includes("/")),
              ...msg.files,
            ],
            workspaceLoadingId: undefined,
            workspaceError: undefined,
          }));
        }
        break;
      }
      case "workspace.git": {
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        const { shouldUpdateGlobal } = dispatchWorkspaceGit(msg, eventStore.getState().currentWorkspaceId);
        if (shouldUpdateGlobal) {
          eventStore.setState({ gitStatus: msg.status, gitEntries: msg.entries ?? [], gitLoaded: true, workspaceError: undefined });
        }
        break;
      }
      case "model.list":
        restoreProviderProfilesFromModelConfigs(msg.configs);
        eventStore.setState((st) => {
          const available = msg.configs.filter((config) => config.enabled);
          const sessionOptions = st.currentSessionId
            ? withRunOptionDefaults(st.runOptionsBySession[st.currentSessionId], st.draftRunOptions)
            : undefined;
          const candidate = sessionOptions?.modelId ?? st.draftRunOptions.modelId ?? st.selectedModelId;
          const selectedModelId = available.some((config) => config.id === candidate)
            ? candidate
            : available[0]?.id;
          if (selectedModelId && selectedModelId !== candidate) {
            if (st.currentSessionId) {
              const runOptionsBySession = { ...st.runOptionsBySession, [st.currentSessionId]: { ...sessionOptions, modelId: selectedModelId } };
              saveRunOptions(runOptionsBySession);
              return { modelConfigs: msg.configs, modelConfigsLoaded: true, selectedModelId, runOptionsBySession };
            }
            const draftRunOptions = { ...st.draftRunOptions, modelId: selectedModelId };
            saveNewSessionRunOptions(draftRunOptions);
            return { modelConfigs: msg.configs, modelConfigsLoaded: true, selectedModelId, draftRunOptions };
          }
          return { modelConfigs: msg.configs, modelConfigsLoaded: true, selectedModelId };
        });
        const restoredProviders = new Set<string>();
        for (const config of msg.configs) {
          if (!restoredProviders.add(config.provider)) continue;
          invoke<string | null>("secret_get", { key: `model.apiKey:${config.provider}` })
            .then((value) => {
              if (value) eventStore.getState().send({ type: "secret.set", requestId: rid(), key: `model.apiKey:${config.provider}`, value });
            })
            .catch((error) => console.error("credential restore failed", error));
        }
        break;
      case "model.updated":
        eventStore.setState((st) => {
          const modelConfigs = [msg.config, ...st.modelConfigs.filter((c) => c.id !== msg.config.id)];
          if (st.selectedModelId) return { modelConfigs };
          if (st.currentSessionId) {
            const sessionOptions = withRunOptionDefaults(st.runOptionsBySession[st.currentSessionId], st.draftRunOptions);
            const runOptionsBySession = { ...st.runOptionsBySession, [st.currentSessionId]: { ...sessionOptions, modelId: msg.config.id } };
            saveRunOptions(runOptionsBySession);
            return { modelConfigs, selectedModelId: msg.config.id, runOptionsBySession };
          }
          const draftRunOptions = { ...st.draftRunOptions, modelId: msg.config.id };
          saveNewSessionRunOptions(draftRunOptions);
          return { modelConfigs, selectedModelId: msg.config.id, draftRunOptions };
        });
        restoreProviderProfilesFromModelConfigs(eventStore.getState().modelConfigs);
        break;
      case "skills.list":
        eventStore.setState({ skills: msg.skills });
        break;
      case "skills.cloud.list":
        cloudRequests.get(msg.requestId)?.resolve(msg);
        break;
      case "skills.cloud.installed":
        eventStore.setState((state) => ({ skills: [...state.skills.filter((skill) => skill.id !== msg.skill.id), msg.skill] }));
        cloudRequests.get(msg.requestId)?.resolve(msg);
        break;
      case "skills.deleted":
        eventStore.setState((state) => ({ skills: state.skills.filter((skill) => skill.id !== msg.skillId) }));
        skillMutationRequests.get(msg.requestId)?.resolve(msg);
        break;
      case "skills.imported":
      case "skills.created":
      case "skills.builtin.changed":
        eventStore.setState((state) => ({ skills: [...state.skills.filter((skill) => skill.id !== msg.skill.id), msg.skill] }));
        skillMutationRequests.get(msg.requestId)?.resolve(msg);
        break;
      case "skills.content":
        skillMutationRequests.get(msg.requestId)?.resolve(msg);
        break;
      case "skills.updated": {
        const replacedIds = new Set([msg.skill.id, ...(msg.previousSkillId ? [msg.previousSkillId] : [])]);
        eventStore.setState((state) => {
          const index = state.skills.findIndex((skill) => replacedIds.has(skill.id));
          if (index === -1) return { skills: [...state.skills, msg.skill] };
          const next = state.skills.filter((skill) => !replacedIds.has(skill.id));
          next.splice(index, 0, msg.skill);
          return { skills: next };
        });
        skillMutationRequests.get(msg.requestId)?.resolve(msg);
        break;
      }
      case "plugins.list":
        eventStore.setState({ plugins: msg.plugins });
        break;
      case "browser.status":
        if (msg.status.targetConnected) rememberBrowserConnection();
        eventStore.setState({ browserStatus: msg.status });
        break;
      case "browser.current-url":
        browserUrlRequests.get(msg.requestId)?.resolve(msg.url);
        break;
      case "reach.channels":
        eventStore.setState({ reachChannels: msg.channels });
        break;
      case "subagent.list":
        eventStore.setState({ subagentConfig: msg.config });
        try {
          window.localStorage.setItem(SUBAGENTS_STORAGE_KEY, JSON.stringify(msg.config.profiles));
          window.localStorage.setItem(CAPABILITY_ROUTING_STORAGE_KEY, JSON.stringify(msg.config.routing));
          window.localStorage.setItem(SUBAGENT_RUNTIME_STORAGE_KEY, JSON.stringify(msg.config.runtime));
        } catch (error) {
          console.error("subagent configuration cache failed", error);
        }
        break;
      case "mcp.icons":
        useMcpIcons.setState(msg.icons, true);
        break;
      case "mcp.list":
        for (const server of msg.servers) if (server.disabled || mcpAvailable(server)) finishMcpConnection(server.id);
        eventStore.setState(st => ({ mcpServers: msg.servers,
          mcpConnectingIds: [...new Set([...st.mcpConnectingIds.filter(id => [...mcpConnectRequests.values()].includes(id)), ...msg.servers.filter(server => server.connecting).map(server => server.id)])],
          oauthAuthorization: msg.servers.some(server => server.id === st.oauthAuthorization?.serverId && !server.disabled && !mcpAvailable(server)) ? st.oauthAuthorization : undefined,
          githubDeviceAuthorization: msg.servers.some(server => server.id === st.githubDeviceAuthorization?.serverId && !server.disabled && !mcpAvailable(server)) ? st.githubDeviceAuthorization : undefined,
        }));
        break;
      case "mcp.connected":
        finishMcpConnection(msg.serverId);
        eventStore.setState((st) => ({
          mcpServers: st.mcpServers.map((server) => server.id === msg.serverId ? { ...server, connecting: false, connected: true, available: true, toolCount: msg.toolCount } : server),
          githubDeviceAuthorization: st.githubDeviceAuthorization?.serverId === msg.serverId ? undefined : st.githubDeviceAuthorization,
          oauthAuthorization: st.oauthAuthorization?.serverId === msg.serverId ? undefined : st.oauthAuthorization,
        }));
        break;
      case "mcp.oauth.authorization":
        eventStore.setState({ oauthAuthorization: { requestId: msg.requestId, serverId: msg.serverId, url: msg.url, state: msg.state } });
        openUrl(msg.url).catch((error) => {
          console.error("OAuth browser launch failed", error);
          eventStore.setState({ lastError: localizeError(error) });
          finishMcpConnection(msg.serverId);
        });
        break;
      case "mcp.github.device":
        eventStore.setState({ githubDeviceAuthorization: msg });
        if (new URL(msg.verificationUri).hostname === "github.com") openUrl(msg.verificationUri).catch((error) => {
          console.error("GitHub login launch failed", error);
          eventStore.setState({ lastError: localizeError(error) });
        });
        break;
      case "mcp.oauth.saved":
        if (msg.key.endsWith(".tokens") || !msg.key.endsWith(".client")) eventStore.setState({ oauthAuthorization: undefined });
        break;
      case "mcp.oauth.invalidated":
        eventStore.setState((st) => ({
          mcpServers: st.mcpServers.map((server) => server.id === msg.serverId ? { ...server, connected: false, available: false, toolCount: 0 } : server),
        }));
        break;
      case "mcp.oauth.token":
        eventStore.setState({ lastError: "OAuth token was not intercepted by the native credential bridge" });
        break;
      case "permission.list":
        eventStore.setState({ permissionRules: msg.rules });
        break;
      case "permission.updated":
        eventStore.setState((st) => ({ permissionRules: [msg.rule, ...st.permissionRules.filter((r) => !(r.subjectId === msg.rule.subjectId && r.permission === msg.rule.permission))] }));
        break;
      case "error":
        if (dispatchClaudeSyncError(msg.requestId, msg.message)) break;
        // Notification snapshots are an optional UI enhancement. A sidecar
        // from before this command was added must not turn that compatibility
        // gap into a visible red error; the next handshake will advertise the
        // capability when the runtime supports it.
        if (msg.message === "invalid or unsupported command: session.subagentNotifications") break;
        if (msg.requestId && pendingSessionMessageRequests.has(msg.requestId)) {
          const pending = pendingSessionMessageRequests.get(msg.requestId)!;
          const sessionId = pending.sessionId;
          const isLatestRequest = latestSessionMessageRequest.get(sessionId) === msg.requestId;
          pendingSessionMessageRequests.delete(msg.requestId);
          if (!isLatestRequest) break;
          clearSessionMessageRequests(sessionId);
          const owner = sessionStore(useStore, sessionId);
          if (owner.getState().messagesLoadingSessionId === sessionId) {
            owner.setState({ messagesLoadingSessionId: undefined, lastError: displayRuntimeError(msg.message) });
          }
          break;
        }
        if (dispatchFilePreviewError(msg.requestId, msg.message)) break;
        if (dispatchMemoryError(msg.requestId, msg.message)) break;
        if (dispatchExecutionStatsError(msg.requestId, msg.message)) break;
        if (dispatchServerError(msg.requestId, msg.message) || dispatchServerTerminalError(msg.requestId, msg.message)) break;
        if (msg.requestId && stopRequests.has(msg.requestId)) {
          const request = stopRequests.get(msg.requestId)!;
          stopRequests.delete(msg.requestId);
          finishStopRequest(request.sessionId, request.runId);
          eventStore.setState({ lastError: displayRuntimeError(msg.message) });
          // The runtime no longer runs it: reconcile instead of staying "running" forever.
          void s.send({ type: "session.runs", requestId: rid(), sessionId: request.sessionId });
          break;
        }
        if (msg.requestId && pendingTitleRequests.has(msg.requestId)) {
          const sessionId = pendingTitleRequests.get(msg.requestId)!;
          pendingTitleRequests.delete(msg.requestId);
          eventStore.setState((state) => ({ titleGeneratingSessionIds: state.titleGeneratingSessionIds.filter((id) => id !== sessionId) }));
          break;
        }
        const compactingSessionId = msg.requestId && Object.entries(eventStore.getState().compactionStatuses).find(([, status]) => status.requestId === msg.requestId)?.[0];
        if (compactingSessionId) {
          eventStore.setState((state) => {
            const compactionStatuses = { ...state.compactionStatuses };
            delete compactionStatuses[compactingSessionId];
            return { compactionStatuses, lastError: displayRuntimeError(msg.message) };
          });
          break;
        }
        if (msg.requestId && steerRequests.has(msg.requestId)) {
          steerRequests.get(msg.requestId)?.resolve(false);
          break;
        }
        if (msg.requestId && skillMutationRequests.has(msg.requestId)) {
          skillMutationRequests.get(msg.requestId)?.reject(new Error(msg.message));
          break;
        }
        if (msg.requestId && cloudRequests.has(msg.requestId)) {
          cloudRequests.get(msg.requestId)?.reject(new Error(msg.message));
          break;
        }
        if (msg.requestId && browserUrlRequests.has(msg.requestId)) {
          browserUrlRequests.get(msg.requestId)?.reject(new Error(msg.message));
          break;
        }
        if (msg.requestId) {
          const serverId = mcpConnectRequests.get(msg.requestId);
          if (serverId) {
            finishMcpConnection(serverId);
            eventStore.setState((st) => ({
              githubDeviceAuthorization: st.githubDeviceAuthorization?.serverId === serverId ? undefined : st.githubDeviceAuthorization,
              oauthAuthorization: st.oauthAuthorization?.serverId === serverId ? undefined : st.oauthAuthorization,
            }));
          }
        }
        const workspaceRequest = msg.requestId ? workspaceRequests.get(msg.requestId) : undefined;
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        const workspaceErrorDispatch = dispatchWorkspaceError(msg.requestId, msg.message, eventStore.getState().currentWorkspaceId);
        const shouldSetGlobalWorkspaceError = workspaceErrorDispatch.shouldUpdateGlobal || (Boolean(workspaceRequest) && !workspaceErrorDispatch.handledByOwner);
        if (msg.requestId && pendingAgentRuns.has(msg.requestId)) {
          const pending = pendingAgentRuns.get(msg.requestId)!;
          pendingAgentRuns.delete(msg.requestId);
          if (!pending.runId && pending.queueItemId) getQoneMessageQueue(pending.sessionId)?.settleSend(pending.queueItemId, false);
          pendingMessageReplacements.delete(pending.sessionId);
          finishStopRequest(pending.sessionId);
          if (pending.sessionId === eventStore.getState().currentSessionId) {
            clearDelta(pending.sessionId);
            eventStore.setState({
              runningSessionIds: eventStore.getState().runningSessionIds.filter((id) => id !== pending.sessionId),
              chatRunError: { sessionId: pending.sessionId, userMessageId: pending.userMessageId, detail: msg.message },
              running: false,
              streaming: "",
              streamingParts: [],
              activeMessageSequence: undefined,
              preparedToolCallIds: [],
              activeRunId: undefined,
              titleGeneratingSessionIds: eventStore.getState().titleGeneratingSessionIds.filter((id) => id !== pending.sessionId),
            });
          }
          break;
        }
        eventStore.setState((st) => ({
          lastError: displayRuntimeError(msg.message),
          ...(shouldSetGlobalWorkspaceError ? { workspaceError: msg.message } : {}),
          ...(st.creatingSession ? { creatingSession: false, pendingMessage: undefined } : {}),
          ...(st.running && !st.activeRunId && ![...pendingAgentRuns.values()].some((pending) => pending.sessionId === st.currentSessionId) ? { running: false } : {}),
        }));
        break;
      case "session.compacted":
      case "session.compactionInterrupted":
        eventStore.setState((state) => {
          const pending = state.compactionStatuses[msg.sessionId];
          if (pending?.requestId !== msg.requestId) return state;
          // A runtime started before the marker protocol change can still
          // finish an in-flight compaction after the frontend hot reloads.
          const marker: CompactionMarkerInfo = isCompactionMarker(msg.marker) ? msg.marker : {
            id: msg.requestId,
            throughMessageId: pending.throughMessageId,
            createdAt: Date.now(),
            status: msg.type === "session.compacted" ? "completed" : "interrupted",
            source: "manual",
          };
          const compactionStatuses = { ...state.compactionStatuses };
          delete compactionStatuses[msg.sessionId];
          return {
            compactionStatuses,
            ...(msg.type === "session.compactionInterrupted" ? { lastError: displayRuntimeError(msg.message) } : {}),
            ...(state.currentSessionId === msg.sessionId
              ? { compactions: [...state.compactions.filter((item) => item.id !== marker.id), marker] }
              : {}),
          };
        });
        break;
      case "session.context":
        pendingContextUsageRequests.delete(msg.requestId);
        eventStore.setState((state) => state.contextUsageRequestId === msg.requestId &&
          state.currentSessionId === msg.sessionId && state.selectedModelId === msg.model
          ? { contextUsageRequestId: undefined, contextUsage: { sessionId: msg.sessionId, model: msg.model, tokens: msg.tokens, contextWindow: msg.contextWindow } }
          : state);
        break;
      case "agent.event": {
        const ev = msg.event;
        lastSequence = Math.max(lastSequence, ev.sequence);
        if (ev.runId) lastRunSequences.set(ev.runId, Math.max(lastRunSequences.get(ev.runId) ?? -1, ev.sequence));
        handleAgentEvent(ev, eventStore, dependencies);
        break;
      }
      case "file.preview":
        dispatchFilePreview(msg);
        break;
      case "file.read": {
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        const { shouldUpdateGlobal } = dispatchFileRead(msg, eventStore.getState().currentWorkspaceId);
        if (shouldUpdateGlobal) {
          eventStore.setState({ openFile: { workspaceId: msg.workspaceId, path: msg.path, content: msg.content }, workspaceError: undefined });
        }
        break;
      }
      case "workspace.gitDiff": {
        if (msg.requestId) workspaceRequests.delete(msg.requestId);
        const { shouldUpdateGlobal } = dispatchWorkspaceGitDiff(msg, eventStore.getState().currentWorkspaceId);
        if (shouldUpdateGlobal) {
          eventStore.setState({ gitDiffView: { workspaceId: msg.workspaceId, path: msg.path, diff: msg.diff }, workspaceError: undefined });
        }
        break;
      }
      case "events.replay":
        for (const ev of msg.events) {
          lastSequence = Math.max(lastSequence, ev.sequence);
          // Feed replayed events through the same reducer on the next reconnect.
          // Current UI state is intentionally not rebuilt from stale tool cards;
          // persisted messages/runs are authoritative and are loaded above.
        }
        break;
    }
    }
  };
  const ready = listen<RuntimeEvent | RuntimeEvent[] | string>("runtime-event", (event) => receive(event.payload));
  void ready
    .then(() => useStore.getState().send({ type: "ping", requestId: rid() }))
    .catch((error) => {
      wired = false;
      console.error("runtime listener setup failed", error);
    });
}
