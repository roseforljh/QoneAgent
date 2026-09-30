import { translateCurrent as t } from "./localization";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { openUrl } from "@tauri-apps/plugin-opener";
import { assistantPartsFromPiMessage, applyAssistantToolEvent, applyReasoningDelta, type AssistantMessagePart, type ArtifactInfo, type CompactionMarkerInfo, type MessageInfo, type RunInfo, type RuntimeEvent } from "@qone/protocol";
import { saveRunOptions } from "./lib/run-options";
import { getQoneMessageQueue } from "./lib/qone-message-queue";
import { sessionStore, switchSessionState } from "./lib/session-execution-state";
import {
  clearTrackedWorkspaceRequests,
  dispatchFileRead,
  dispatchWorkspaceError,
  dispatchWorkspaceFiles,
  dispatchWorkspaceGit,
  dispatchWorkspaceGitDiff,
} from "./lib/workspace-view-state";
import type { ToolCall } from "./store";

const rid = () => crypto.randomUUID();
const SUBAGENTS_STORAGE_KEY = "qone-subagents";
const CAPABILITY_ROUTING_STORAGE_KEY = "qone-capability-routing";
const SUBAGENT_RUNTIME_STORAGE_KEY = "qone-subagent-runtime";
let wired = false;
let lastSequence = -1;
export function initRuntimeBridge(dependencies: ReturnType<typeof import("./store").bridgeDependencies>) {
  const { useStore, hasTauriBridge, clearDelta, flushNow, queueDelta, queueReasoning, deltas, pendingAgentRuns, stopRequestedSessionIds, stopRequests, pendingTitleRequests, mcpConnectRequests, restoredMcpSecrets, metadataRequests, finishMcpConnection, handshakeRequests, steerRequests, workspaceRequests, cloudRequests, skillMutationRequests, pendingMessageReplacements, stopRun, finishStopRequest, rememberBrowserConnection, browserAutoReconnectEnabled, displayRuntimeError, isCompactionMarker, alignToolCallIds, ensureStreamingToolPart, setMetadataLookupSupported } = dependencies;
  if (wired) return;
  if (!hasTauriBridge() || typeof listen !== "function" || typeof invoke !== "function") return;
  wired = true;

  const ready = listen<string>("runtime-event", (e) => {
    if (e.payload.includes('"type":"runtime.exited"')) {
      for (const sessionId of deltas.keys()) clearDelta(sessionId);
      setMetadataLookupSupported(false);
      pendingAgentRuns.clear();
      stopRequestedSessionIds.clear();
      stopRequests.clear();
      pendingTitleRequests.clear();
      mcpConnectRequests.clear();
      restoredMcpSecrets.clear();
      clearTrackedWorkspaceRequests();
      for (const request of metadataRequests.values()) request.reject(new Error("Runtime exited"));
      useStore.setState((st) => {
        const userMessage = st.messages.slice().reverse().find((message) => message.role === "user");
        return {
          connected: false,
          backgroundSessions: {},
          runningSessionIds: [],
          compactionStatuses: {},
          autoCompactionStatuses: {},
          browserStatus: st.browserStatus ? { ...st.browserStatus, targetConnected: false, phase: "error", lastError: t("browser.runtimeExited") } : undefined,
          mcpConnectingIds: [],
          githubDeviceAuthorization: undefined,
          running: false,
          titleGeneratingSessionIds: [],
          activeRunId: undefined,
          approvals: [],
          streaming: "",
          streamingParts: [],
          activeMessageSequence: undefined,
          preparedToolCallIds: [],
          queueItems: [],
          queueLoadedSessionId: undefined,
          editingQueueItem: undefined,
          ...(st.running && st.currentSessionId && userMessage ? {
            chatRunError: { sessionId: st.currentSessionId, userMessageId: userMessage.id, detail: "Runtime exited" },
          } : {}),
        };
      });
      invoke("runtime_restart")
        .then(() => useStore.getState().send({ type: "ping", requestId: rid() }))
        .catch((error) => console.error("runtime restart failed", error));
      return;
    }
    let msg: RuntimeEvent;
    try {
      msg = JSON.parse(e.payload);
    } catch {
      return;
    }
    if (msg.type === "model.metadata-resolved") {
      const pending = metadataRequests.get(msg.requestId);
      if (msg.models.every((model) => model.sources && ["contextWindow", "maxTokens", "reasoning", "input", "output"].every((field) => typeof model.sources[field as keyof typeof model.sources] === "string"))) pending?.resolve(msg.models);
      else pending?.reject(new Error("MODEL_METADATA_UNSUPPORTED"));
      return;
    }
    if (msg.type === "error" && msg.requestId && metadataRequests.has(msg.requestId)) {
      metadataRequests.get(msg.requestId)?.reject(new Error(msg.message));
      return;
    }
    const targetSessionId = msg.type === "agent.event" ? msg.event.sessionId
      : "sessionId" in msg ? msg.sessionId
      : "subagent" in msg ? msg.subagent.parentSessionId
      : msg.type === "goal.updated" ? msg.goal.sessionId
      : msg.type === "error" && msg.requestId ? pendingAgentRuns.get(msg.requestId)?.sessionId
      : undefined;
    const eventStore = sessionStore(useStore, targetSessionId);
    const s = eventStore.getState();
    switch (msg.type) {
      case "pong":
        if (stopRequests.has(msg.requestId)) break;
        if (steerRequests.has(msg.requestId)) {
          steerRequests.get(msg.requestId)?.resolve(true);
          break;
        }
        if (pendingAgentRuns.has(msg.requestId)) {
          const { sessionId, userMessageId } = pendingAgentRuns.get(msg.requestId)!;
          pendingAgentRuns.delete(msg.requestId);
          eventStore.setState((state) => state.currentSessionId === sessionId
            ? { messages: state.messages.map((message) => message.id === userMessageId ? { ...message, persisted: true } : message) }
            : state);
          void s.send({ type: "session.runs", requestId: rid(), sessionId });
          break;
        }
        if (!handshakeRequests.delete(msg.requestId)) break;
        setMetadataLookupSupported(Boolean(msg.capabilities?.includes("model.resolve-metadata") && msg.capabilities?.includes("model.metadata-sources")));
        eventStore.setState({ connected: true, runtimeCapabilities: msg.capabilities ?? [], ...(msg.compaction ?? {}) });
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
        s.send({ type: "events.replay", requestId: rid(), sessionId: eventStore.getState().currentSessionId, afterSequence: lastSequence });
        break;
      case "global-prompt":
        eventStore.setState({ globalPrompt: msg.content, globalPromptPath: msg.path, globalPromptDirectory: msg.directory, globalPromptLoaded: true });
        break;
      case "session.created":
        flushNow();
        eventStore.setState((st) => ({
          runOptionsBySession: {
            ...st.runOptionsBySession,
            [msg.session.id]: {
              ...(st.runOptionsBySession[msg.session.id] ?? {}),
              ...(st.creatingSession ? st.draftRunOptions : {}),
              ...(!st.runOptionsBySession[msg.session.id]?.modelId && !st.draftRunOptions.modelId && st.selectedModelId ? { modelId: st.selectedModelId } : {}),
            },
          },
          selectedModelId: st.draftRunOptions.modelId ?? st.runOptionsBySession[msg.session.id]?.modelId ?? st.selectedModelId,
          draftRunOptions: {},
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
          artifacts: [],
          running: false,
          activeRunId: undefined,
          modelRequest: undefined,
          approvals: [],
          ...switchSessionState(st, msg.session.id),
        }));
        saveRunOptions(eventStore.getState().runOptionsBySession);
        if (eventStore.getState().creatingSession && eventStore.getState().pendingMessage !== undefined) {
          queueMicrotask(() => {
            const state = eventStore.getState();
            if (state.currentSessionId === msg.session.id && state.pendingMessage !== undefined) state.runAgent(state.pendingMessage, undefined, state.pendingAttachments, undefined, state.pendingGoal);
          });
        }
        break;
      case "session.list": {
        const state = eventStore.getState();
        const cur = state.currentSessionId;
        const selected = msg.sessions.find((session) => session.id === cur) ?? msg.sessions[0];
        const selectionChanged = selected?.id !== cur;
        if (selectionChanged) flushNow();
        const storedModelId = selected ? state.runOptionsBySession[selected.id]?.modelId : undefined;
        eventStore.setState({
          sessions: msg.sessions,
          sessionsLoaded: true,
          currentSessionId: selected?.id,
          currentWorkspaceId: selected?.workspaceId ?? state.currentWorkspaceId,
          ...(selected?.workspaceId && selected.workspaceId !== state.currentWorkspaceId ? { workspaceLoadingId: selected.workspaceId } : {}),
          selectedModelId: storedModelId,
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
            artifacts: [],
            ...switchSessionState(state, selected?.id),
          } : {}),
        });
        if (selected) {
          s.send({ type: "session.messages", requestId: rid(), sessionId: selected.id });
          s.send({ type: "goal.get", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.queue.list", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.toolCalls", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.runs", requestId: rid(), sessionId: selected.id });
          s.send({ type: "session.subagents", requestId: rid(), sessionId: selected.id });
          s.send({ type: "artifact.list", requestId: rid(), sessionId: selected.id });
          if (selected.workspaceId) eventStore.getState().refreshWorkspace(selected.workspaceId);
        }
        break;
      }
      case "session.search":
        if (msg.query === eventStore.getState().activeSearchQuery) eventStore.setState({ searchResults: msg.results, searchLoading: false });
        break;
      case "session.renamed":
        for (const [requestId, sessionId] of pendingTitleRequests) {
          if (sessionId === msg.session.id) pendingTitleRequests.delete(requestId);
        }
        eventStore.setState((st) => ({
          sessions: st.sessions.map((session) => session.id === msg.session.id ? msg.session : session),
          titleGeneratingSessionIds: st.titleGeneratingSessionIds.filter((id) => id !== msg.session.id),
        }));
        break;
      case "session.messages":
        if (msg.sessionId === eventStore.getState().currentSessionId) {
          const replacedMessageId = pendingMessageReplacements.get(msg.sessionId);
          if (replacedMessageId && msg.messages.some((message) => message.id === replacedMessageId)) break;
          if (replacedMessageId) pendingMessageReplacements.delete(msg.sessionId);
          const messages = msg.messages.map((m: MessageInfo) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            persisted: true,
            parts: m.parts,
            attachments: m.attachments,
            runId: m.runId,
            createdAt: m.createdAt,
            goalId: m.goalId,
          }));
          eventStore.setState((st) => {
            const pendingIds = new Set([...pendingAgentRuns.values()].filter((pending) => pending.sessionId === msg.sessionId).map((pending) => pending.userMessageId));
            if (st.chatRunError) pendingIds.add(st.chatRunError.userMessageId);
            const merged = [...messages, ...st.messages.filter((message) => pendingIds.has(message.id) && !messages.some((saved) => saved.id === message.id))];
            return { messagesLoadingSessionId: undefined, messages: merged, compactions: msg.compactions ?? [], toolCalls: alignToolCallIds(st.toolCalls, merged) };
          });
        }
        break;
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
                runId: t.runId, toolName: t.toolName,
                status: t.status === "failed" || t.status === "cancelled" ? "failed" : t.status === "running" ? "running" : t.status === "waiting_approval" ? "waiting" : "success",
                args: (() => { try { return t.arguments ? JSON.parse(t.arguments) : undefined; } catch { return undefined; } })(),
                argsText: t.arguments ?? undefined,
                result: (() => { try { return t.resultSummary ? JSON.parse(t.resultSummary) : undefined; } catch { return t.resultSummary; } })(),
                summary: t.resultSummary,
                startedAt: t.startedAt,
                completedAt: t.completedAt,
              } satisfies ToolCall));
            const live = new Map(st.toolCalls.filter((call) => call.runId === st.activeRunId).map((call) => [call.toolCallId, call]));
            const merged = calls.map((call) => live.get(call.toolCallId) ?? call);
            for (const call of live.values()) if (!merged.some((saved) => saved.toolCallId === call.toolCallId)) merged.push(call);
            return { toolCalls: alignToolCallIds(merged, st.messages) };
          });
        }
        break;
      case "session.runs":
        {
          const activeRun = msg.runs.find((run) => ["created", "running", "waiting_approval", "paused"].includes(run.status));
          eventStore.setState((st) => {
            const pending = [...pendingAgentRuns.values()].some((request) => request.sessionId === msg.sessionId);
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
          if (activeRun && stopRequestedSessionIds.has(msg.sessionId)) stopRun(msg.sessionId, activeRun.id);
        }
        break;
      case "session.subagents":
        if (msg.sessionId === eventStore.getState().currentSessionId) {
          eventStore.setState((st) => {
            // The initial list request can race with a live subagent.updated
            // event. Merge the snapshot so a newly created run is not erased
            // by a response that was produced just before it was created.
            const byId = new Map(st.subagents.map((item) => [item.id, item]));
            for (const item of msg.subagents) {
              const live = byId.get(item.id);
              byId.set(item.id, live?.streaming ? live : item);
            }
            return { subagents: [...byId.values()].sort((a, b) => a.startedAt - b.startedAt) };
          });
        }
        break;
      case "subagent.updated":
        if (msg.subagent.parentSessionId === eventStore.getState().currentSessionId) {
          eventStore.setState((st) => ({ subagents: [...st.subagents.filter((item) => item.id !== msg.subagent.id), msg.subagent].sort((a, b) => a.startedAt - b.startedAt) }));
        }
        break;
      case "subagent.query":
      case "subagent.controlled":
        if (msg.subagent.parentSessionId === eventStore.getState().currentSessionId) {
          eventStore.setState((st) => ({ subagents: [...st.subagents.filter((item) => item.id !== msg.subagent.id), msg.subagent].sort((a, b) => a.startedAt - b.startedAt) }));
        }
        break;
      case "artifact.list":
        if (msg.sessionId === eventStore.getState().currentSessionId) eventStore.setState({ artifacts: msg.artifacts });
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
        eventStore.getState().refreshWorkspace(msg.workspace.id);
        eventStore.setState({ draftWorkspaceId: msg.workspace.id, draftDockId: crypto.randomUUID(), currentSessionId: undefined, messagesLoadingSessionId: undefined, creatingSession: false, pendingMessage: undefined, messages: [], compactions: [], streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], runs: [], subagents: [], artifacts: [], approvals: [], ...switchSessionState(eventStore.getState()) });
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
          return {
            workspaces,
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
        eventStore.setState((st) => ({
          modelConfigs: msg.configs,
          selectedModelId: st.selectedModelId ?? (st.currentSessionId ? st.runOptionsBySession[st.currentSessionId]?.modelId : st.draftRunOptions.modelId) ?? msg.configs[0]?.id,
        }));
        for (const config of msg.configs) {
          invoke<string | null>("secret_get", { key: `model.apiKey:${config.provider}` })
            .then((value) => {
              if (value) eventStore.getState().send({ type: "secret.set", requestId: rid(), key: `model.apiKey:${config.provider}`, value });
            })
            .catch((error) => console.error("credential restore failed", error));
        }
        break;
      case "model.updated":
        eventStore.setState((st) => ({
          modelConfigs: [msg.config, ...st.modelConfigs.filter((c) => c.id !== msg.config.id)],
          selectedModelId: st.selectedModelId ?? msg.config.id,
        }));
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
      case "skills.imported":
      case "skills.created":
        eventStore.setState((state) => ({ skills: [...state.skills.filter((skill) => skill.id !== msg.skill.id), msg.skill] }));
        skillMutationRequests.get(msg.requestId)?.resolve(msg);
        break;
      case "plugins.list":
        eventStore.setState({ plugins: msg.plugins });
        break;
      case "browser.status":
        if (msg.status.targetConnected) rememberBrowserConnection();
        eventStore.setState({ browserStatus: msg.status });
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
      case "mcp.list":
        eventStore.setState({ mcpServers: msg.servers });
        for (const server of msg.servers) {
          const oauthKeys = server.authMode === "oauth"
            ? [`mcp.oauth:${server.id}.client`, `mcp.oauth:${server.id}.tokens`]
            : [server.oauth?.tokenSecretKey ?? `mcp.oauth:${server.id}`];
          const keys = [...oauthKeys, ...Object.values(server.env ?? {})
            .filter((value) => value.startsWith("$mcp.env:"))
            .map((value) => value.slice(1))];
          void (async () => {
            for (const key of keys) {
              if (restoredMcpSecrets.has(key)) continue;
              restoredMcpSecrets.add(key);
              try {
                const value = await invoke<string | null>("secret_get", { key });
                if (value) await eventStore.getState().send({ type: "secret.set", requestId: rid(), key, value });
              } catch (error) {
                restoredMcpSecrets.delete(key);
                console.error("MCP credential restore failed", error);
              }
            }
          })();
        }
        break;
      case "mcp.connected":
        finishMcpConnection(msg.serverId);
        eventStore.setState((st) => ({
          mcpServers: st.mcpServers.map((server) => server.id === msg.serverId ? { ...server, connected: true, toolCount: msg.toolCount } : server),
          githubDeviceAuthorization: st.githubDeviceAuthorization?.serverId === msg.serverId ? undefined : st.githubDeviceAuthorization,
          oauthAuthorization: st.oauthAuthorization?.serverId === msg.serverId ? undefined : st.oauthAuthorization,
        }));
        break;
      case "mcp.oauth.authorization":
        eventStore.setState({ oauthAuthorization: { requestId: msg.requestId, serverId: msg.serverId, url: msg.url, state: msg.state } });
        openUrl(msg.url).catch((error) => {
          console.error("OAuth browser launch failed", error);
          eventStore.setState({ lastError: String(error) });
          finishMcpConnection(msg.serverId);
        });
        break;
      case "mcp.github.device":
        eventStore.setState({ githubDeviceAuthorization: msg });
        if (new URL(msg.verificationUri).hostname === "github.com") openUrl(msg.verificationUri).catch((error) => {
          console.error("GitHub login launch failed", error);
          eventStore.setState({ lastError: String(error) });
        });
        break;
      case "mcp.oauth.saved":
        if (msg.key.endsWith(".tokens") || !msg.key.endsWith(".client")) eventStore.setState({ oauthAuthorization: undefined });
        break;
      case "mcp.oauth.invalidated":
        // Do not restore a rejected token while native deletion/list updates arrive.
        restoredMcpSecrets.add(msg.key);
        eventStore.setState((st) => ({
          mcpServers: st.mcpServers.map((server) => server.id === msg.serverId ? { ...server, connected: false, toolCount: 0 } : server),
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
        if (msg.requestId && stopRequests.has(msg.requestId)) {
          const request = stopRequests.get(msg.requestId)!;
          stopRequests.delete(msg.requestId);
          stopRequestedSessionIds.delete(request.sessionId);
          eventStore.setState({ lastError: displayRuntimeError(msg.message) });
          break;
        }
        if (msg.requestId && pendingTitleRequests.has(msg.requestId)) {
          const sessionId = pendingTitleRequests.get(msg.requestId)!;
          pendingTitleRequests.delete(msg.requestId);
          eventStore.setState((state) => ({ titleGeneratingSessionIds: state.titleGeneratingSessionIds.filter((id) => id !== sessionId) }));
          break;
        }
        if (msg.requestId && msg.requestId === eventStore.getState().contextUsageRequestId) {
          eventStore.setState({ contextUsageRequestId: undefined, contextUsage: undefined });
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
        eventStore.setState((state) => state.contextUsageRequestId === msg.requestId &&
          state.currentSessionId === msg.sessionId && state.selectedModelId === msg.model
          ? { contextUsageRequestId: undefined, contextUsage: { sessionId: msg.sessionId, model: msg.model, tokens: msg.tokens, contextWindow: msg.contextWindow } }
          : state);
        break;
      case "agent.event": {
        const ev = msg.event;
        lastSequence = Math.max(lastSequence, ev.sequence);
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
            runs: st.runs.some((run) => run.id === ev.runId)
              ? st.runs
              : [{ id: ev.runId!, sessionId: ev.sessionId ?? st.currentSessionId ?? "", status: "running", startedAt: ev.timestamp }, ...st.runs],
          }));
          if (ev.sessionId && stopRequestedSessionIds.has(ev.sessionId)) stopRun(ev.sessionId, ev.runId);
        }
        const p = ev.payload as Record<string, unknown> | undefined;

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
          eventStore.setState({ activeMessageSequence: ev.sequence, streaming: "" });
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
                    summary: JSON.stringify(p?.content ?? p?.result ?? "").slice(0, 20_000),
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
            toolCalls: st.toolCalls.map((tool) => tool.toolName === String(p?.toolName ?? "") && tool.status === "running" ? { ...tool, status: "waiting" } : tool),
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
            eventStore.setState((st) => ({ streaming: "", streamingParts: [], activeMessageSequence: undefined, preparedToolCallIds: [], running: false, activeRunId: undefined, approvals: [], runningSessionIds: ev.sessionId ? st.runningSessionIds.filter((id) => id !== ev.sessionId) : st.runningSessionIds }));
          }
          if (ev.type === "agent.cancelled") {
            const cancelledSessionId = ev.sessionId ?? eventStore.getState().currentSessionId;
            eventStore.setState((st) => ({ titleGeneratingSessionIds: st.titleGeneratingSessionIds.filter((id) => id !== cancelledSessionId) }));
          }
          const sessionId = ev.sessionId ?? eventStore.getState().currentSessionId;
          if (sessionId) {
            const state = eventStore.getState();
            state.send({ type: "session.messages", requestId: rid(), sessionId });
            state.send({ type: "session.toolCalls", requestId: rid(), sessionId });
            state.send({ type: "session.runs", requestId: rid(), sessionId });
            state.send({ type: "artifact.list", requestId: rid(), sessionId });
          }
        }
        break;
      }
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
  });
  void ready
    .then(() => useStore.getState().send({ type: "ping", requestId: rid() }))
    .catch((error) => {
      wired = false;
      console.error("runtime listener setup failed", error);
    });
}
