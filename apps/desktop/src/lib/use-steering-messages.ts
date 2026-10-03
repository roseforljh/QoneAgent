import { useMemo } from "react";
import type { QueueItemInfo } from "@qone/protocol";
import type { ChatMessage } from "../store";
import type { QueueBundle } from "./qone-message-queue";
import { withMessageQuote } from "./message-quote";

const emptyItems: QueueBundle["adapter"]["steerItems"] = [];

/** Submitted steers belong in the conversation while delivery is being confirmed. */
export function steeringMessages(queue: QueueBundle | null, items: QueueBundle["adapter"]["steerItems"], runId?: string): ChatMessage[] {
  return items.flatMap((entry) => {
    const id = queue?.getPersistentId(entry.id);
    if (!id) return [];
    const item = queue!.getItem(id);
    return [{ id, role: "user", content: withMessageQuote(item?.text ?? entry.prompt, item?.quote), quote: item?.quote, attachments: item?.attachments, createdAt: item?.createdAt, runId }];
  });
}

export function appendSteeringMessages(messages: ChatMessage[], submitted: ChatMessage[]): ChatMessage[] {
  if (!submitted.length) return messages;
  const existing = new Set(messages.map((message) => message.id));
  const pending = submitted.filter((message) => !existing.has(message.id));
  return pending.length ? [...messages, ...pending] : messages;
}

export function useSteeringMessages(queue: QueueBundle | null, adapter: QueueBundle["adapter"] | undefined, snapshot: QueueItemInfo[], runId?: string): ChatMessage[] {
  const items = adapter?.steerItems ?? emptyItems;
  // Runtime snapshots also refresh attachments after asynchronous preparation.
  return useMemo(() => steeringMessages(queue, items, runId), [queue, items, snapshot, runId]);
}
