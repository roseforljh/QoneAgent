import type { QueueItemInfo } from "@qone/protocol";
import { useStore } from "../store";
import { getQoneMessageQueue, setQoneMessageQueue } from "./qone-message-queue";
import { sessionStore } from "./session-execution-state";

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
  const busy = () => {
    const state = sessionStore(useStore, sessionId).getState();
    return state.running || Boolean(state.compactionStatuses[sessionId]);
  };
  let wasBusy = busy();
  const unsubscribe = useStore.subscribe((state) => {
    if (!state.connected || !state.sessions.some((session) => session.id === sessionId)) {
      queue.controller.hold();
      unsubscribe();
      bindings.delete(sessionId);
      setQoneMessageQueue(sessionId, undefined);
      return;
    }
    const isBusy = busy();
    if (isBusy === wasBusy) return;
    wasBusy = isBusy;
    if (isBusy) queue.controller.notifyBusy();
    else { queue.controller.notifyIdle(); queue.releaseIdle(); }
  });
  bindings.set(sessionId, unsubscribe);
  if (wasBusy) queue.controller.notifyBusy();
  else { queue.controller.notifyIdle(); queue.releaseIdle(); }
}
