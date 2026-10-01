import type { BaseComposerRuntimeCore } from "@assistant-ui/core/internal";
import type { AppendMessage } from "@assistant-ui/react";
import type { ComposerDraft } from "./composer-drafts";
import type { QueueBundle } from "./qone-message-queue";

export function queueMessageDraft(message: AppendMessage): ComposerDraft {
  const source = message.metadata.custom.quote;
  const quote = source && typeof source === "object" && "text" in source && "messageId" in source
    && typeof source.text === "string" && typeof source.messageId === "string"
    ? { text: source.text, messageId: source.messageId } : undefined;
  return { text: message.content.filter((part) => part.type === "text").map((part) => part.text).join(""), attachments: message.attachments ?? [], quote };
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
