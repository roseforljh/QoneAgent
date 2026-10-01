import type { QueueItemInfo } from "@qone/protocol";
import { useStore } from "../store";
import { getQoneMessageQueue, setQoneMessageQueue } from "./qone-message-queue";

const hydrated = new WeakSet<object>();
export function hydrateSessionQueue(queue: NonNullable<ReturnType<typeof getQoneMessageQueue>>, items: QueueItemInfo[]) {
  if (hydrated.has(queue)) return;
  hydrated.add(queue);
  queue.restore(items);
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
  let sessionExists = useStore.getState().sessions.some((session) => session.id === sessionId);
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (state.sessions !== previous.sessions) sessionExists = state.sessions.some((session) => session.id === sessionId);
    if (!state.connected || !sessionExists) {
      queue.controller.hold();
      unsubscribe();
      bindings.delete(sessionId);
      setQoneMessageQueue(sessionId, undefined);
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
}
