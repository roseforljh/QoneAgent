import type { StoreApi } from "zustand";
import type { AgentState } from "../store";
import { selectSessionState, sessionStore } from "./session-execution-state";
import { sameVisibleState, subscribeAllSessions } from "./store-subscriptions";

/** A view of one conversation. It never changes the sidebar selection. */
export function createConversationStore(source: StoreApi<AgentState>, sessionId: string): StoreApi<AgentState> {
  const owner = sessionStore(source, sessionId);
  const actions: Partial<AgentState> = {
    runAgent: (text, replaceId, attachments, queueId, goal, _unusedSessionId, quote) => source.getState().runAgent(text, replaceId, attachments, queueId, goal, sessionId, quote),
    stopAgent: () => source.getState().stopAgent(sessionId),
    pauseGoal: () => source.getState().pauseGoal(sessionId),
    resumeGoal: () => source.getState().resumeGoal(sessionId),
    clearGoal: () => source.getState().clearGoal(sessionId),
    approve: (id) => source.getState().approve(id, sessionId),
    reject: (id) => source.getState().reject(id, sessionId),
    setSelectedModel: (id) => source.getState().setSelectedModel(id, sessionId),
    setRunPermissionMode: (mode) => source.getState().setRunPermissionMode(mode, sessionId),
    setRunThinking: (id, level) => source.getState().setRunThinking(id, level, sessionId),
    compactSession: () => source.getState().compactSession(sessionId),
    refreshContextUsage: () => source.getState().refreshContextUsage(sessionId),
  };
  // Zustand's external-store snapshot must be referentially stable between updates.
  const views = new WeakMap<AgentState, AgentState>();
  let previousView: AgentState | undefined;
  const view = (state: AgentState) => {
    let result = views.get(state);
    if (!result) {
      result = { ...selectSessionState(state, sessionId), ...actions };
      if (previousView && sameVisibleState(result, previousView)) result = previousView;
      previousView = result;
      views.set(state, result);
    }
    return result;
  };
  return {
    getState: () => view(source.getState()),
    getInitialState: () => view(source.getInitialState()),
    setState: owner.setState,
    subscribe: (listener) => subscribeAllSessions(source, (state, previous) => {
      const before = view(previous);
      const after = view(state);
      if (before !== after) listener(after, before);
    }),
  };
}
