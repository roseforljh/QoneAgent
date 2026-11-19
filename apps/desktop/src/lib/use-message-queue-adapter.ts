import { useMemo, useSyncExternalStore } from "react";
import type { QueueBundle } from "./qone-message-queue";

/**
 * Both lanes form one snapshot for assistant-ui's external runtime. A new
 * snapshot object marks each change for React; its lanes read the live queue
 * because assistant-ui checks right after a send whether the queue grew,
 * before React publishes the next snapshot. A frozen copy fails that check
 * and keeps a queued message with attachments "in transit", rendered as a
 * user bubble in the conversation.
 */
export function createMessageQueueAdapterStore(queue: QueueBundle | null) {
  let snapshot: QueueBundle["adapter"] | undefined;
  let lanes: Pick<QueueBundle["adapter"], "items" | "steerItems"> | undefined;
  const getSnapshot = () => {
    if (!queue) return undefined;
    const { items, steerItems } = queue.adapter;
    if (!snapshot || lanes?.items !== items || lanes.steerItems !== steerItems) {
      lanes = { items, steerItems };
      snapshot = Object.defineProperties({ ...queue.adapter }, {
        items: { enumerable: true, get: () => queue.adapter.items },
        steerItems: { enumerable: true, get: () => queue.adapter.steerItems },
      });
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
