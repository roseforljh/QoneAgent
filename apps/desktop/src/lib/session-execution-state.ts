import type { AgentState } from "../store";

// These fields belong to a conversation, never to the selected sidebar item.
export function emptySessionState() {
  return {
    messages: [], compactions: [], streaming: "", streamingParts: [],
    activeMessageSequence: undefined, preparedToolCallIds: [], toolCalls: [], waitingSubagents: [],
    runs: [], subagents: [], subagentNotifications: [], artifacts: [], approvals: [], running: false,
    activeRunId: undefined, modelRequest: undefined, chatRunError: undefined,
    goal: undefined, queueItems: [], queueLoadedSessionId: undefined,
    editingQueueItem: undefined, contextUsage: undefined, contextUsageRequestId: undefined,
    messagesLoadingSessionId: undefined,
  } satisfies Partial<AgentState>;
}

export type SessionExecutionState = Pick<AgentState, keyof ReturnType<typeof emptySessionState>>;
const sessionKeys = Object.keys(emptySessionState()) as (keyof SessionExecutionState)[];
export const sessionStateKeys: ReadonlySet<string> = new Set(sessionKeys);
const idleSessionState = emptySessionState();

/** Runtime state can reset; unsent edits remain owned by their conversations. */
export function queueEditsOnDisconnect(state: Pick<AgentState, "editingQueueItem" | "backgroundSessions">) {
  return {
    editingQueueItem: state.editingQueueItem,
    backgroundSessions: Object.fromEntries(Object.entries(state.backgroundSessions)
      .filter(([, session]) => session.editingQueueItem)
      .map(([id, session]) => [id, { ...emptySessionState(), editingQueueItem: session.editingQueueItem }])),
  };
}

function snapshot(state: AgentState): SessionExecutionState {
  return Object.fromEntries(sessionKeys.map((key) => [key, state[key]])) as SessionExecutionState;
}

export function switchSessionState(state: AgentState, sessionId?: string): Partial<AgentState> {
  const backgroundSessions = { ...state.backgroundSessions };
  if (state.currentSessionId) backgroundSessions[state.currentSessionId] = snapshot(state);
  const selected = sessionId ? backgroundSessions[sessionId] : undefined;
  if (sessionId) delete backgroundSessions[sessionId];
  return { ...emptySessionState(), ...selected, backgroundSessions };
}

type Store = Pick<typeof import("../store").useStore, "getState" | "setState">;

export function conversationSession(state: AgentState, sessionId = state.currentSessionId) {
  return state.sessions.find((session) => session.id === sessionId) ?? (sessionId ? state.sideChats[sessionId] : undefined);
}

export function selectSessionState(state: AgentState, sessionId?: string): AgentState {
  if (!sessionId || state.currentSessionId === sessionId) return state;
  return {
    ...state, ...idleSessionState, ...state.backgroundSessions[sessionId],
    currentSessionId: sessionId,
    currentWorkspaceId: conversationSession(state, sessionId)?.workspaceId,
    selectedModelId: state.runOptionsBySession[sessionId]?.modelId,
    creatingSession: false,
  };
}

/** Route updates without ever changing the real selection or exposing another chat to React. */
export function sessionStore(store: Store, sessionId?: string): Store {
  if (!sessionId) return store;
  // A single runtime event reads the routed store several times. Keep the
  // derived view stable for the lifetime of the source snapshot so those
  // reads do not repeatedly copy the complete AgentState.
  let sourceSnapshot: AgentState | undefined;
  let derivedSnapshot: AgentState | undefined;
  const getState = (): AgentState => {
    const source = store.getState();
    if (source !== sourceSnapshot || !derivedSnapshot) {
      sourceSnapshot = source;
      derivedSnapshot = selectSessionState(source, sessionId);
    }
    return derivedSnapshot;
  };
  const setState: Store["setState"] = (update) => {
    store.setState((state) => {
      const previous = getState();
      const patch = typeof update === "function" ? update(previous) : update;
      if (patch === previous) return state;
      if (state.currentSessionId === sessionId) return patch;
      const local = Object.fromEntries(Object.entries(patch).filter(([key]) => sessionStateKeys.has(key)));
      const global = Object.fromEntries(Object.entries(patch).filter(([key]) => !sessionStateKeys.has(key) && key !== "currentSessionId"));
      return { ...global, backgroundSessions: {
        ...state.backgroundSessions,
        [sessionId]: { ...emptySessionState(), ...state.backgroundSessions[sessionId], ...local },
      } };
    });
  };
  return { getState, setState };
}
