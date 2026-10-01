import { useMemo, useSyncExternalStore } from "react";
import type { QueueBundle } from "./qone-message-queue";

/** Both lanes form one immutable snapshot for assistant-ui's external runtime. */
export function createMessageQueueAdapterStore(queue: QueueBundle | null) {
  let snapshot: QueueBundle["adapter"] | undefined;
  const getSnapshot = () => {
    if (!queue) return undefined;
    const { items, steerItems } = queue.adapter;
    if (!snapshot || snapshot.items !== items || snapshot.steerItems !== steerItems) {
      snapshot = { ...queue.adapter, items, steerItems };
    }
    return snapshot;
  };
  return {
    subscribe: queue?.controller.subscribe ?? (() => () => {}),
    getSnapshot,
  };
}

export function useMessageQueueAdapter(queue: QueueBundle | null) {
  const store = useMemo(() => createMessageQueueAdapterStore(queue), [queue]);
  return useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
}
