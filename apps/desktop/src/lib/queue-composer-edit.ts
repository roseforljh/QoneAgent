import type { BaseComposerRuntimeCore } from "@assistant-ui/core/internal";
import type { AppendMessage } from "@assistant-ui/react";
import type { ComposerDraft } from "./composer-drafts";
import type { QueueBundle } from "./qone-message-queue";
import { messageQuote } from "./message-quote";
import { appendInlineQuote } from "./inline-quote";

/** Items queued before quotes went inline carry quote metadata; edit them as an inline chip. */
export function queueMessageDraft(message: AppendMessage): ComposerDraft {
  const quote = messageQuote(message);
  const text = message.content.filter((part) => part.type === "text").map((part) => part.text).join("");
  return { text: quote ? appendInlineQuote(text, quote.text) : text, attachments: message.attachments ?? [], quote: undefined };
}

/** Restore actual chips atomically. addAttachment rebuilds them asynchronously
 * and drops File metadata when given CreateAttachment inputs. */
export function beginQueueComposerEdit(queue: QueueBundle, localId: string, composer: BaseComposerRuntimeCore) {
  const persistentId = queue.getPersistentId(localId);
  const item = persistentId ? queue.getItem(persistentId) : undefined;
  const message = queue.getMessage(localId);
  if (!item || !message || composer.text !== "" || composer.attachments.length || composer.quote) return undefined;
  if (!queue.beginEdit(localId)) return undefined;
  if (!composer.restoreDraft(queueMessageDraft(message))) {
    queue.cancelEdit();
    return undefined;
  }
  return item;
}
