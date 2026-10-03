import type { QueueItemInfo } from "@qone/protocol";
import { useStore } from "../store";
import { getQoneMessageQueue, setQoneMessageQueue } from "./qone-message-queue";
import { subscribeAllSessions } from "./store-subscriptions";
import { sessionById } from "./store-indexes";

const hydrated = new WeakSet<object>();
export function hydrateSessionQueue(queue: NonNullable<ReturnType<typeof getQoneMessageQueue>>, items: QueueItemInfo[], editingItemId?: string) {
  if (hydrated.has(queue)) return;
  hydrated.add(queue);
  queue.restore(items, editingItemId);
}

const bindings = new Map<string, () => void>();

/** Queue execution follows its conversation even when its React view unmounts. */
export function bindSessionQueue(sessionId: string, queue: NonNullable<ReturnType<typeof getQoneMessageQueue>>) {
  if (bindings.has(sessionId)) return;
  if (!useStore.getState().connected) return;
  setQoneMessageQueue(sessionId, queue);
  const busy = (state: ReturnType<typeof useStore.getState>) =>
    Boolean(state.currentSessionId === sessionId ? state.running : state.backgroundSessions[sessionId]?.running) ||
    Boolean(state.compactionStatuses[sessionId]);
  let wasBusy = busy(useStore.getState());
  const exists = (state: ReturnType<typeof useStore.getState>) => Boolean(sessionById(state.sessions, sessionId) || state.sideChats[sessionId]);
  let sessionExists = exists(useStore.getState());
  const unsubscribe = subscribeAllSessions(useStore, (state, previous) => {
    if (state.sessions !== previous.sessions || state.sideChats !== previous.sideChats) sessionExists = exists(state);
    if (!state.connected || !sessionExists) {
      queue.suspend();
      unsubscribe();
      bindings.delete(sessionId);
      if (!queue.hasTransfers()) setQoneMessageQueue(sessionId, undefined);
      return;
    }
    const isBusy = busy(state);
    if (isBusy === wasBusy) return;
    wasBusy = isBusy;
    if (isBusy) queue.controller.notifyBusy();
    else { queue.controller.notifyIdle(); queue.releaseIdle(); }
  });
  bindings.set(sessionId, unsubscribe);
  if (wasBusy) queue.controller.notifyBusy();
  else { queue.controller.notifyIdle(); queue.releaseIdle(); }
  queue.resume();
}
