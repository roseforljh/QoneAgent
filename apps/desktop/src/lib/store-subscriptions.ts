import type { StoreApi } from "zustand";
import type { AgentState } from "../store";

const sources = new WeakMap<StoreApi<AgentState>["getState"], StoreApi<AgentState>["subscribe"]>();

export function sameVisibleState(left: AgentState, right: AgentState) {
  return Object.keys(right).every((key) => key === "backgroundSessions"
    || left[key as keyof AgentState] === right[key as keyof AgentState]);
}

export function isolateBackgroundSubscriptions(store: StoreApi<AgentState>) {
  const subscribe = store.subscribe;
  sources.set(store.getState, subscribe);
  store.subscribe = (listener) => subscribe((state, previous) => {
    if (!sameVisibleState(state, previous)) listener(state, previous);
  });
}

export function subscribeAllSessions(store: StoreApi<AgentState>, listener: (state: AgentState, previous: AgentState) => void) {
  return (sources.get(store.getState) ?? store.subscribe)(listener);
}
