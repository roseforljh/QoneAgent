import type { StoreApi } from "zustand";
import type { AgentState } from "../store";
import { sessionStateKeys } from "./session-execution-state";

const sources = new WeakMap<StoreApi<AgentState>["getState"], StoreApi<AgentState>["subscribe"]>();
const sharedChanges = new WeakMap<AgentState, { previous: AgentState; changed: boolean }>();

export function conversationStateChanged(state: AgentState, previous: AgentState, sessionId: string) {
  let shared = sharedChanges.get(state);
  if (!shared || shared.previous !== previous) {
    shared = { previous, changed: Object.keys(state).some((key) => key !== "backgroundSessions" && !sessionStateKeys.has(key)
      && state[key as keyof AgentState] !== previous[key as keyof AgentState]) };
    sharedChanges.set(state, shared);
  }
  if (shared.changed) return true;
  if (state.currentSessionId !== sessionId) return state.backgroundSessions[sessionId] !== previous.backgroundSessions[sessionId];
  return [...sessionStateKeys].some((key) => state[key as keyof AgentState] !== previous[key as keyof AgentState]);
}

export function sameVisibleState(left: AgentState, right: AgentState) {
  return Object.keys(right).every((key) => key === "backgroundSessions"
    || left[key as keyof AgentState] === right[key as keyof AgentState]);
}

export function isolateBackgroundSubscriptions(store: StoreApi<AgentState>) {
  const subscribe = store.subscribe;
  const visibility = new WeakMap<AgentState, { previous: AgentState; changed: boolean }>();
  sources.set(store.getState, subscribe);
  store.subscribe = (listener) => subscribe((state, previous) => {
    let result = visibility.get(state);
    if (!result || result.previous !== previous) {
      result = { previous, changed: !sameVisibleState(state, previous) };
      visibility.set(state, result);
    }
    if (result.changed) listener(state, previous);
  });
}

export function subscribeAllSessions(store: StoreApi<AgentState>, listener: (state: AgentState, previous: AgentState) => void) {
  return (sources.get(store.getState) ?? store.subscribe)(listener);
}
