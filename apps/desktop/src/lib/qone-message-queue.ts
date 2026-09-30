import {
  createMessageQueue,
  type AppendMessage,
  type MessageQueueController,
  type QueueItemState,
} from "@assistant-ui/react";
import type { MessageAttachmentInfo, QueueItemInfo } from "@qone/protocol";
import { sameUserInput } from "@qone/protocol";
import { serializeMessageAttachments } from "./message-attachments";
import { createNativeAttachmentFile } from "./native-attachment-file";

type QueueCallbacks = {
  sessionId: string;
  isRunning: () => boolean;
  editPending?: (message: AppendMessage) => boolean;
  isDuplicate?: (message: AppendMessage, attachments: MessageAttachmentInfo[]) => boolean;
  send: (message: AppendMessage, queueItemId: string, attachments: MessageAttachmentInfo[]) => void;
  steer: (message: AppendMessage, queueItemId: string, attachments: MessageAttachmentInfo[]) => Promise<boolean>;
  sync: (items: QueueItemInfo[]) => void;
  onError?: (message: string) => void;
};

type QueueBundle = {
  adapter: { items: readonly QueueItemState[]; steerItems: readonly QueueItemState[]; enqueue: (message: AppendMessage) => void; steer: (message: AppendMessage) => void; move: (id: string, placement: { lane?: "queue" | "steer"; insertAfter?: string | null; insertBefore?: string | null }) => void; edit: (id: string, message: AppendMessage) => void; remove: (id: string) => void };
  controller: MessageQueueController;
  restore: (items: QueueItemInfo[]) => void;
  beginEdit: (id: string) => boolean;
  cancelEdit: () => void;
  releaseIdle: () => void;
  edit: (id: string, message: AppendMessage, preservedAttachments?: MessageAttachmentInfo[]) => void;
  remove: (id: string) => void;
  settleSteer: (persistentId: string, delivered: boolean) => void;
  getPersistentId: (localId: string) => string | undefined;
  getLocalId: (persistentId: string) => string | undefined;
  getItem: (persistentId: string) => QueueItemInfo | undefined;
};

const activeQueues = new Map<string, QueueBundle>();
export const getQoneMessageQueue = (sessionId: string) => activeQueues.get(sessionId);
export const setQoneMessageQueue = (sessionId: string, bundle: QueueBundle | undefined) => {
  if (bundle) activeQueues.set(sessionId, bundle);
  else activeQueues.delete(sessionId);
};

const textOf = (message: AppendMessage) => message.content
  .filter((part): part is { type: "text"; text: string } => part.type === "text")
  .map((part) => part.text)
  .join("")
  .trim();

export const fileFromDataUrl = (name: string, mimeType: string, data: string): File | undefined => {
  const match = /^data:[^,]*;base64,([A-Za-z0-9+/=]+)$/i.exec(data);
  if (!match || typeof atob !== "function" || typeof File !== "function") return undefined;
  try {
    const binary = atob(match[1]);
    const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
    return new File([bytes], name, { type: mimeType });
  } catch {
    return undefined;
  }
};

const toMessage = (item: QueueItemInfo): AppendMessage => ({
  role: "user",
  parentId: null,
  sourceId: null,
  runConfig: undefined,
  createdAt: new Date(item.createdAt),
  metadata: { custom: {} },
  content: item.text ? [{ type: "text", text: item.text }] : [],
  attachments: (item.attachments ?? []).map((attachment) => {
    const file = attachment.localPath
      ? createNativeAttachmentFile(attachment.name, attachment.mimeType, attachment.localPath, 0, attachment.type === "folder")
      : attachment.type === "file"
        ? fileFromDataUrl(attachment.name, attachment.mimeType, attachment.data)
        : undefined;
    return {
      id: crypto.randomUUID(),
      type: attachment.type === "folder" ? "file" : attachment.type,
      name: attachment.name,
      contentType: attachment.mimeType,
      file,
      status: { type: "complete" as const },
      content: attachment.type === "image"
        ? [{ type: "image" as const, image: attachment.data, filename: attachment.name }]
        : [{ type: "file" as const, data: attachment.data, filename: attachment.name, mimeType: attachment.mimeType }],
    };
  }),
});

export function createQoneMessageQueue(callbacks: QueueCallbacks): QueueBundle {
  const messages = new Map<string, AppendMessage>();
  const persistentIds = new Map<string, string>();
  const attachments = new Map<string, MessageAttachmentInfo[]>();
  const timestamps = new Map<string, { createdAt: number; updatedAt: number }>();
  const steeringIds = new Set<string>();
  const attachmentVersions = new Map<string, number>();
  const holdReasons = new Set<string>();
  let editingLocalId: string | undefined;
  let restoring = false;
  let dispatchingMessage: AppendMessage | undefined;
  const serializedMessages = new WeakMap<AppendMessage, Promise<MessageAttachmentInfo[]>>();
  const mergedMessages = new WeakSet<AppendMessage>();
  const serialize = (message: AppendMessage) => {
    let result = serializedMessages.get(message);
    if (!result) {
      result = serializeMessageAttachments(message);
      serializedMessages.set(message, result);
    }
    return result;
  };
  const sameMessage = (left: AppendMessage, a: MessageAttachmentInfo[], right: AppendMessage, b: MessageAttachmentInfo[]) =>
    sameUserInput({ content: textOf(left), attachments: a }, { content: textOf(right), attachments: b });

  const hold = (reason: string) => {
    if (holdReasons.size === 0) controller.hold();
    holdReasons.add(reason);
  };
  const releaseHold = (reason: string) => {
    holdReasons.delete(reason);
    if (holdReasons.size === 0) controller.release();
  };

  const snapshot = (): QueueItemInfo[] => {
    const lanes = [
      ...controller.adapter.steerItems.map((item) => ({ item, lane: "steer" as const })),
      ...controller.adapter.items.map((item) => ({ item, lane: "queue" as const })),
    ];
    return lanes.flatMap(({ item, lane }, position) => {
      const message = messages.get(item.id);
      const id = persistentIds.get(item.id);
      if (!message || !id) return [];
      const time = timestamps.get(item.id) ?? { createdAt: Date.now(), updatedAt: Date.now() };
      return [{
        id,
        sessionId: callbacks.sessionId,
        text: textOf(message),
        attachments: attachments.get(item.id),
        lane,
        status: lane === "steer" ? "steering" : "queued",
        position,
        createdAt: time.createdAt,
        updatedAt: time.updatedAt,
      } satisfies QueueItemInfo];
    });
  };

  const persist = () => {
    if (!restoring) callbacks.sync(snapshot());
  };

  const controller = createMessageQueue({
    run: (message) => {
      const localId = [...messages.entries()].find(([, value]) => value === message)?.[0];
      if (!localId) return;
      const queueItemId = persistentIds.get(localId);
      if (!queueItemId) return;
      // Attachment serialization is asynchronous. Keep the next item queued
      // until this one has actually entered runAgent and marked the session busy.
      hold("dispatch");
      dispatchingMessage = message;
      const fallbackAttachments = attachments.get(localId) ?? [];
      messages.delete(localId);
      persistentIds.delete(localId);
      attachments.delete(localId);
      timestamps.delete(localId);
      attachmentVersions.delete(localId);
      void serialize(message).catch(() => fallbackAttachments).then((serialized) => {
        callbacks.send(message, queueItemId, serialized);
        if (callbacks.isRunning()) controller.notifyBusy();
        persist();
      }).catch(reportError).finally(() => {
        dispatchingMessage = undefined;
        releaseHold("dispatch");
      });
    },
  });

  // Editing only has to stop the item under edit from being dispatched; the
  // rest of the queue keeps flowing until that item reaches the head.
  const syncEditHold = () => {
    const head = controller.adapter.steerItems[0] ?? controller.adapter.items[0];
    const shouldHold = editingLocalId !== undefined && head?.id === editingLocalId;
    if (shouldHold && !holdReasons.has("edit")) hold("edit");
    else if (!shouldHold && holdReasons.has("edit")) releaseHold("edit");
  };
  controller.subscribe(syncEditHold);

  const reportError = (error: unknown) => callbacks.onError?.(error instanceof Error ? error.message : String(error));

  const findNewId = (before: readonly QueueItemState[], after: readonly QueueItemState[]) =>
    after.find((item) => !before.some((candidate) => candidate.id === item.id))?.id;

  const adapter = {
    get items() { return controller.adapter.items; },
    get steerItems() { return controller.adapter.steerItems; },
    enqueue(message: AppendMessage) {
      if (callbacks.editPending?.(message)) return;
      const tail = controller.adapter.items.at(-1) ?? controller.adapter.steerItems.at(-1);
      const previous = tail ? messages.get(tail.id) : dispatchingMessage;
      const previousDispatching = !tail && Boolean(dispatchingMessage);
      if (!message.attachments?.length && (previous
        ? !previous.attachments?.length && sameMessage(previous, [], message, [])
        : callbacks.isDuplicate?.(message, []))) return;
      const holdForMapping = !callbacks.isRunning();
      if (holdForMapping) hold("mapping");
      else controller.notifyBusy();
      try {
        const before = controller.adapter.items;
        controller.adapter.enqueue(message);
        const localId = findNewId(before, controller.adapter.items);
        if (localId) {
          messages.set(localId, message);
          const persistentId = crypto.randomUUID();
          persistentIds.set(localId, persistentId);
          const now = Date.now();
          timestamps.set(localId, { createdAt: now, updatedAt: now });
          // Hold dispatch until attachment equality is known. Comparing names
          // or assistant-ui attachment ids would merge different files.
          hold(`prepare:${localId}`);
          void serialize(message).then(async (serialized) => {
            if (messages.get(localId) !== message) return;
            const previousFiles = previous ? await serialize(previous).catch(() => undefined) : undefined;
            const previousPending = previous && (previousDispatching || mergedMessages.has(previous) || [...messages.values()].includes(previous));
            if (previousPending && previousFiles
              ? sameMessage(previous, previousFiles, message, serialized)
              : !tail && callbacks.isDuplicate?.(message, serialized)) {
              mergedMessages.add(message);
              if (messages.get(localId) === message) adapter.remove(localId);
              return;
            }
            if (messages.get(localId) !== message) return;
            attachments.set(localId, serialized);
            persist();
          }).catch((error) => {
            if (messages.get(localId) === message) reportError(error);
          }).finally(() => releaseHold(`prepare:${localId}`));
        }
        persist();
      } catch (error) {
        if (!holdForMapping) controller.notifyIdle();
        throw error;
      } finally {
        if (holdForMapping) releaseHold("mapping");
      }
    },
    steer(message: AppendMessage) {
      // assistant-ui calls adapter.steer for the default mid-run Composer
      // send. Qone reserves steering for the explicit queue action, so a
      // normal send always enters the FIFO lane here.
      adapter.enqueue(message);
    },
    move(localId: string, placement: { lane?: "queue" | "steer"; insertAfter?: string | null; insertBefore?: string | null }) {
      const message = messages.get(localId);
      const queueItemId = persistentIds.get(localId);
      if (!message || !queueItemId || steeringIds.has(localId) || editingLocalId === localId) return;
      if (placement.lane === "steer" && placement.insertAfter === null && placement.insertBefore === undefined && callbacks.isRunning()) {
        if (steeringIds.has(localId)) return;
        steeringIds.add(localId);
        hold(`steer:${localId}`);
        const queuedItems = [...controller.adapter.items];
        const restoreIndex = queuedItems.findIndex((item) => item.id === localId);
        controller.adapter.move(localId, { lane: "steer", insertAfter: null });
        persist();
        void serializeMessageAttachments(message)
          .catch(() => attachments.get(localId) ?? [])
          .then((serialized) => callbacks.steer(message, queueItemId, serialized))
          .catch(() => false)
          .then((accepted) => {
            if (!accepted && messages.has(localId)) {
              const restoreBefore = queuedItems.slice(restoreIndex + 1).find((item) => controller.adapter.items.some((current) => current.id === item.id))?.id;
              controller.adapter.move(localId, { lane: "queue", insertBefore: restoreBefore ?? null });
              persist();
            }
            if (!accepted) {
              steeringIds.delete(localId);
              releaseHold(`steer:${localId}`);
            }
          });
        return;
      }
      controller.adapter.move(localId, placement);
      const time = timestamps.get(localId);
      if (time) timestamps.set(localId, { ...time, updatedAt: Date.now() });
      persist();
    },
    edit(localId: string, message: AppendMessage, preservedAttachments?: MessageAttachmentInfo[]) {
      if (!messages.has(localId) || steeringIds.has(localId)) return;
      messages.set(localId, message);
      controller.adapter.edit(localId, message);
      const time = timestamps.get(localId);
      if (time) timestamps.set(localId, { ...time, updatedAt: Date.now() });
      const version = (attachmentVersions.get(localId) ?? 0) + 1;
      attachmentVersions.set(localId, version);
      void serializeMessageAttachments(message).then((serialized) => {
        if (attachmentVersions.get(localId) !== version || !messages.has(localId)) return;
        attachments.set(localId, serialized);
        persist();
      }).catch((error) => {
        // The edited attachments are unusable: keep the last valid list and
        // tell the user instead of silently swapping attachments.
        if (attachmentVersions.get(localId) !== version || !messages.has(localId)) return;
        attachments.set(localId, preservedAttachments ?? attachments.get(localId) ?? []);
        persist();
        reportError(error);
      });
      persist();
      if (editingLocalId === localId) {
        editingLocalId = undefined;
        syncEditHold();
      }
    },
    remove(localId: string) {
      if (steeringIds.has(localId)) return;
      controller.adapter.remove(localId);
      messages.delete(localId);
      persistentIds.delete(localId);
      attachments.delete(localId);
      timestamps.delete(localId);
      attachmentVersions.delete(localId);
      persist();
      if (editingLocalId === localId) {
        editingLocalId = undefined;
        syncEditHold();
      }
    },
  };

  const beginEdit = (localId: string) => {
    if (!messages.has(localId) || steeringIds.has(localId)) return false;
    if (editingLocalId && editingLocalId !== localId) return false;
    editingLocalId = localId;
    syncEditHold();
    return true;
  };

  const cancelEdit = () => {
    if (!editingLocalId) return;
    editingLocalId = undefined;
    syncEditHold();
  };

  const restore = (items: QueueItemInfo[]) => {
    restoring = true;
    hold("restore");
    for (const id of steeringIds) releaseHold(`steer:${id}`);
    let normalizedSteer = false;
    try {
      controller.clear();
      messages.clear();
      persistentIds.clear();
      attachments.clear();
      timestamps.clear();
      attachmentVersions.clear();
      steeringIds.clear();
      editingLocalId = undefined;
      holdReasons.delete("edit");
      const ordered = [...items].sort((a, b) => a.position - b.position);
      for (const item of ordered) {
        const message = toMessage(item);
        const lane = item.lane === "steer" && callbacks.isRunning() ? "steer" : "queue";
        if (item.lane === "steer" && lane === "queue") normalizedSteer = true;
        const before = lane === "steer" ? controller.adapter.steerItems : controller.adapter.items;
        if (lane === "steer") controller.adapter.steer(message);
        else controller.adapter.enqueue(message);
        const after = lane === "steer" ? controller.adapter.steerItems : controller.adapter.items;
        const localId = findNewId(before, after);
        if (localId) {
          messages.set(localId, message);
          persistentIds.set(localId, item.id);
          attachments.set(localId, item.attachments ?? []);
          timestamps.set(localId, { createdAt: item.createdAt, updatedAt: item.updatedAt });
          if (lane === "steer") {
            steeringIds.add(localId);
            hold(`steer:${localId}`);
          }
        }
      }
    } finally {
      restoring = false;
      if (!callbacks.isRunning()) releaseHold("restore");
      if (normalizedSteer) persist();
    }
  };

  const settleSteer = (persistentId: string, delivered: boolean) => {
    const localId = [...persistentIds.entries()].find(([, id]) => id === persistentId)?.[0];
    if (!localId) return;
    if (delivered) {
      controller.adapter.remove(localId);
      messages.delete(localId);
      persistentIds.delete(localId);
      attachments.delete(localId);
      timestamps.delete(localId);
      attachmentVersions.delete(localId);
    } else {
      controller.adapter.move(localId, { lane: "queue", insertBefore: controller.adapter.items[0]?.id ?? null });
    }
    steeringIds.delete(localId);
    releaseHold(`steer:${localId}`);
  };

  return {
    adapter,
    controller,
    restore,
    beginEdit,
    cancelEdit,
    releaseIdle: () => releaseHold("restore"),
    edit: adapter.edit,
    remove: adapter.remove,
    settleSteer,
    getPersistentId: (localId) => persistentIds.get(localId),
    getLocalId: (persistentId: string) => [...persistentIds.entries()].find(([, id]) => id === persistentId)?.[0],
    // Read from the local queue, not the runtime snapshot, so a freshly queued
    // item is editable at once. Undefined while its attachments are still
    // being serialized, so an edit never starts from an incomplete list.
    getItem: (persistentId: string) => {
      const localId = [...persistentIds.entries()].find(([, id]) => id === persistentId)?.[0];
      if (!localId || ((messages.get(localId)?.attachments?.length ?? 0) > 0 && !attachments.has(localId))) return undefined;
      return snapshot().find((item) => item.id === persistentId);
    },
  };
}
