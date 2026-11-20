import { localizeError } from "../lib/error-localization";
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
import { messageQuote, withMessageQuote } from "./message-quote";

type QueueCallbacks = {
  sessionId: string;
  isRunning: () => boolean;
  getServerIds?: () => string[];
  getActiveRunId?: () => string | undefined;
  editPending?: (message: AppendMessage) => boolean;
  isDuplicate?: (message: AppendMessage, attachments: MessageAttachmentInfo[]) => boolean;
  /** false restores the input; true waits for runtime acknowledgement; void accepts immediately. */
  send: (message: AppendMessage, queueItemId: string, attachments: MessageAttachmentInfo[]) => boolean | void;
  steer: (message: AppendMessage, queueItemId: string, attachments: MessageAttachmentInfo[], targetRunId?: string) => Promise<boolean | undefined>;
  sync: (items: QueueItemInfo[]) => void;
  onError?: (message: string) => void;
};

export type QueueBundle = {
  adapter: { items: readonly QueueItemState[]; steerItems: readonly QueueItemState[]; enqueue: (message: AppendMessage) => void; steer: (message: AppendMessage) => void; move: (id: string, placement: { lane?: "queue" | "steer"; insertAfter?: string | null; insertBefore?: string | null }) => void; edit: (id: string, message: AppendMessage) => void; remove: (id: string) => void };
  controller: MessageQueueController;
  /** Submit an existing queue item to the active run through the explicit send-now path. */
  steerNow: (id: string) => void;
  restore: (items: QueueItemInfo[], editingItemId?: string) => void;
  beginEdit: (id: string) => boolean;
  cancelEdit: () => void;
  releaseIdle: () => void;
  suspend: () => void;
  edit: (id: string, message: AppendMessage) => Promise<boolean>;
  remove: (id: string) => void;
  settleSteer: (persistentId: string, delivered: boolean) => void;
  settleSend: (persistentId: string, accepted: boolean) => void;
  getPersistentId: (localId: string) => string | undefined;
  getLocalId: (persistentId: string) => string | undefined;
  getItem: (persistentId: string) => QueueItemInfo | undefined;
  /** Current durable order, including detached edits and pending transfers. */
  getSnapshot: () => QueueItemInfo[];
  getMessage: (localId: string) => AppendMessage | undefined;
  transfer: (localId: string, open: (item: QueueItemInfo) => Promise<boolean>) => Promise<boolean>;
  hasTransfers: () => boolean;
  resume: () => void;
  /** After the user stops a run, queued inputs wait until the user sends again. */
  pauseAfterStop: () => void;
};

const QUEUE_PAUSE_PREFIX = "qone:queue-paused:";
export function prunePausedQueues(isLive: (id: string) => boolean) {
  try {
    const storage = window.localStorage;
    for (let index = storage.length - 1; index >= 0; index--) {
      const key = storage.key(index);
      if (key?.startsWith(QUEUE_PAUSE_PREFIX) && !isLive(key.slice(QUEUE_PAUSE_PREFIX.length))) storage.removeItem(key);
    }
  } catch { /* Storage unavailable. */ }
}

const activeQueues = new Map<string, QueueBundle>();
export const getQoneMessageQueue = (sessionId: string) => activeQueues.get(sessionId);
export const setQoneMessageQueue = (sessionId: string, bundle: QueueBundle | undefined) => {
  if (bundle) activeQueues.set(sessionId, bundle);
  else activeQueues.delete(sessionId);
};

export const messageServerIds = (message: AppendMessage): string[] | undefined => {
  const ids = message.metadata?.custom?.serverIds;
  return Array.isArray(ids) ? ids.filter((id): id is string => typeof id === "string") : undefined;
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
  metadata: { custom: { ...(item.quote ? { quote: item.quote } : {}), serverIds: item.serverIds ?? [] } },
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
  const steerAttempts = new Map<string, symbol>();
  const invalidIds = new Set<string>();
  const steerPositions = new Map<string, { before: string[]; after: string[] }>();
  const attachmentVersions = new Map<string, number>();
  const holdReasons = new Set<string>();
  const pauseKey = `${QUEUE_PAUSE_PREFIX}${callbacks.sessionId}`;
  try { if (window.localStorage.getItem(pauseKey) === "1") holdReasons.add("stopped"); } catch { /* Storage unavailable. */ }
  const rememberPaused = (paused: boolean) => {
    try { window.localStorage.setItem(pauseKey, paused ? "1" : "0"); } catch { /* Storage unavailable. */ }
  };
  const transfers = new Map<string, { item: QueueItemInfo; position: { before: string[]; after: string[] } }>();
  let editingLocalId: string | undefined;
  let editPosition: { before: string[]; after: string[] } | undefined;
  let editingItem: QueueItemInfo | undefined;
  let restoring = false;
  let dispatchingMessage: AppendMessage | undefined;
  let generation = 0;
  const pendingSends = new Map<string, { message: AppendMessage; files: MessageAttachmentInfo[]; time: { createdAt: number; updatedAt: number } }>();
  let steerTail = Promise.resolve();
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
    JSON.stringify(messageServerIds(left) ?? []) === JSON.stringify(messageServerIds(right) ?? []) && sameUserInput({ content: withMessageQuote(textOf(left), messageQuote(left)), attachments: a }, { content: withMessageQuote(textOf(right), messageQuote(right)), attachments: b });

  const hold = (reason: string) => {
    if (holdReasons.size === 0) controller.hold();
    holdReasons.add(reason);
  };
  const releaseHold = (reason: string) => {
    holdReasons.delete(reason);
    if (holdReasons.size === 0) controller.release();
  };

  const snapshot = (includeUnprepared = false): QueueItemInfo[] => {
    const lanes = [
      ...controller.adapter.steerItems.map((item) => ({ item, lane: "steer" as const })),
      ...controller.adapter.items.map((item) => ({ item, lane: "queue" as const })),
    ];
    const result: QueueItemInfo[] = lanes.flatMap(({ item, lane }, position) => {
      const message = messages.get(item.id);
      const id = persistentIds.get(item.id);
      if (!message || !id) return [];
      // Persist complete input only. A restart must not turn a still-reading
      // attachment or a failed attachment into a text-only submission.
      if (!includeUnprepared && (invalidIds.has(item.id) || (message.attachments?.length && !attachments.has(item.id)))) return [];
      const time = timestamps.get(item.id) ?? { createdAt: Date.now(), updatedAt: Date.now() };
      return [{
        id,
        sessionId: callbacks.sessionId,
        text: textOf(message),
        quote: messageQuote(message),
        serverIds: messageServerIds(message),
        attachments: attachments.get(item.id),
        lane,
        status: lane === "steer" ? "steering" : "queued",
        position,
        createdAt: time.createdAt,
        updatedAt: time.updatedAt,
      } satisfies QueueItemInfo];
    });
    // Keep an IPC-bound input durable until agent.started confirms acceptance.
    for (const [id, pending] of [...pendingSends].reverse()) result.unshift({
      id, sessionId: callbacks.sessionId, text: textOf(pending.message), quote: messageQuote(pending.message),
      serverIds: messageServerIds(pending.message), attachments: pending.files, lane: "queue", status: "scheduled", position: 0, ...pending.time,
    });
    // Retain the original as a durable recovery copy while the composer owns
    // the edit. It is absent from the dispatch lanes and cannot block FIFO.
    const detached = [...transfers.values()];
    if (editingItem && editPosition && !invalidIds.has(editingLocalId!)) detached.push({ item: editingItem, position: editPosition });
    for (const { item, position } of detached) {
      const next = position.after.map((id) => persistentIds.get(id)).find((id) => result.some((item) => item.id === id));
      const previous = position.before.map((id) => persistentIds.get(id)).find((id) => result.some((item) => item.id === id));
      const index = next ? result.findIndex((item) => item.id === next)
        : previous ? result.findIndex((item) => item.id === previous) + 1 : result.filter((item) => item.lane === "steer").length;
      result.splice(index, 0, { ...item, status: "scheduled" });
    }
    return result.map((item, position) => ({ ...item, position }));
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
      const time = timestamps.get(localId) ?? { createdAt: Date.now(), updatedAt: Date.now() };
      messages.delete(localId);
      persistentIds.delete(localId);
      attachments.delete(localId);
      timestamps.delete(localId);
      attachmentVersions.delete(localId);
      const dispatchGeneration = generation;
      void serialize(message).then((serialized) => {
        if (generation !== dispatchGeneration) return;
        if (holdReasons.has("suspended") || holdReasons.has("stopped")) {
          requeueHead(message, queueItemId, serialized, time);
          controller.notifyIdle();
          return;
        }
        pendingSends.set(queueItemId, { message, files: serialized, time });
        hold(`send:${queueItemId}`);
        const accepted = callbacks.send(message, queueItemId, serialized);
        if (accepted === false) { settleSend(queueItemId, false, true); return; }
        if (accepted !== true) settleSend(queueItemId, true);
        if (callbacks.isRunning()) controller.notifyBusy();
        persist();
      }).catch((error) => {
        if (generation !== dispatchGeneration) return;
        if (pendingSends.has(queueItemId)) settleSend(queueItemId, false, true);
        else {
          hold("send-failed");
          requeueHead(message, queueItemId, fallbackAttachments, time);
          controller.notifyIdle();
        }
        reportError(error);
      }).finally(() => {
        if (generation !== dispatchGeneration) return;
        dispatchingMessage = undefined;
        releaseHold("dispatch");
      });
    },
  });
  if (holdReasons.size) controller.hold();

  const reportError = (error: unknown) => callbacks.onError?.(localizeError(error));

  const positionOf = (localId: string) => {
    const ids = controller.adapter.items.map((item) => item.id);
    // Include inputs temporarily in flight, so restoring several steers in
    // any event order still recovers their original relative positions.
    for (const [id, anchors] of steerPositions) {
      if (ids.includes(id)) continue;
      const next = anchors.after.find((candidate) => ids.includes(candidate));
      const previous = anchors.before.find((candidate) => ids.includes(candidate));
      ids.splice(next ? ids.indexOf(next) : previous ? ids.indexOf(previous) + 1 : 0, 0, id);
    }
    for (const [id, { position }] of transfers) {
      if (ids.includes(id)) continue;
      const next = position.after.find((candidate) => ids.includes(candidate));
      const previous = position.before.find((candidate) => ids.includes(candidate));
      ids.splice(next ? ids.indexOf(next) : previous ? ids.indexOf(previous) + 1 : 0, 0, id);
    }
    const index = ids.indexOf(localId);
    return { before: ids.slice(0, index).reverse(), after: ids.slice(index + 1) };
  };
  const restorePosition = (localId: string, position: { before: string[]; after: string[] }) => {
    const queued = controller.adapter.items;
    const next = position.after.find((id) => queued.some((item) => item.id === id));
    const previous = position.before.find((id) => queued.some((item) => item.id === id));
    controller.adapter.move(localId, next ? { lane: "queue", insertBefore: next }
      : previous ? { lane: "queue", insertAfter: previous } : { lane: "queue", insertAfter: null });
  };
  const forget = (localId: string) => {
    messages.delete(localId);
    persistentIds.delete(localId);
    attachments.delete(localId);
    timestamps.delete(localId);
    attachmentVersions.delete(localId);
    invalidIds.delete(localId);
    for (const reason of holdReasons) if (reason.startsWith(`edit-prepare:${localId}:`)) releaseHold(reason);
  };
  // The composer owns an edited message. Reinsert under the same persistent
  // identity only after its complete input has been validated.
  const reinsertEdit = (localId: string, message: AppendMessage, files: MessageAttachmentInfo[], valid = true) => {
    const persistentId = persistentIds.get(localId)!;
    const time = timestamps.get(localId)!;
    const position = editPosition!;
    hold("edit-restore");
    try {
      const before = controller.adapter.items;
      controller.adapter.enqueue(message);
      const nextId = findNewId(before, controller.adapter.items)!;
      forget(localId);
      messages.set(nextId, message);
      persistentIds.set(nextId, persistentId);
      attachments.set(nextId, files);
      timestamps.set(nextId, time);
      if (!valid) { invalidIds.add(nextId); hold(`invalid:${nextId}`); }
      releaseHold(`invalid:${localId}`);
      // Other edited entries can have referenced the replaced local ID.
      for (const anchors of [...steerPositions.values(), ...[...transfers.values()].map((entry) => entry.position)]) {
        anchors.before = anchors.before.map((id) => id === localId ? nextId : id);
        anchors.after = anchors.after.map((id) => id === localId ? nextId : id);
      }
      editingLocalId = undefined;
      editingItem = undefined;
      editPosition = undefined;
      restorePosition(nextId, position);
      persist();
    } finally { releaseHold("edit-restore"); }
  };

  const findNewId = (before: readonly QueueItemState[], after: readonly QueueItemState[]) =>
    after.find((item) => !before.some((candidate) => candidate.id === item.id))?.id;

  const requeueHead = (message: AppendMessage, queueItemId: string, files: MessageAttachmentInfo[], time: { createdAt: number; updatedAt: number }) => {
    const before = controller.adapter.items;
    controller.adapter.enqueue(message);
    const localId = findNewId(before, controller.adapter.items)!;
    messages.set(localId, message);
    persistentIds.set(localId, queueItemId);
    attachments.set(localId, files);
    timestamps.set(localId, time);
    controller.adapter.move(localId, { lane: "queue", insertAfter: null });
    persist();
  };
  const settleSend = (id: string, accepted: boolean, retryOnIdle = false) => {
    const pending = pendingSends.get(id);
    if (!pending) return;
    hold("settle-send");
    try {
      pendingSends.delete(id);
      if (!accepted) {
        hold(retryOnIdle ? "send-failed" : "send-rejected");
        requeueHead(pending.message, id, pending.files, pending.time);
        controller.notifyIdle();
      } else persist();
      releaseHold(`send:${id}`);
    } finally { releaseHold("settle-send"); }
  };
  // Explicit user actions retry a refused head; only a new send resumes after a stop.
  const releaseRetry = () => { releaseHold("send-rejected"); releaseHold("send-failed"); };
  const resumeAfterStop = () => { rememberPaused(false); releaseHold("stopped"); releaseRetry(); };

  const adapter = {
    get items() { return controller.adapter.items; },
    get steerItems() { return controller.adapter.steerItems; },
    enqueue(message: AppendMessage) {
      message = { ...message, metadata: { ...message.metadata, custom: { ...message.metadata?.custom, serverIds: [...(callbacks.getServerIds?.() ?? messageServerIds(message) ?? [])] } } };
      if (callbacks.editPending?.(message)) return;
      const tail = controller.adapter.items.at(-1) ?? controller.adapter.steerItems.at(-1);
      const previous = tail ? messages.get(tail.id) : dispatchingMessage;
      const previousDispatching = !tail && Boolean(dispatchingMessage);
      if (!message.attachments?.length && (previous
        ? !previous.attachments?.length && sameMessage(previous, [], message, [])
        : callbacks.isDuplicate?.(message, []))) return;
      // Map the new item before releasing a stopped/refused queue.
      hold("mapping");
      const wasRunning = callbacks.isRunning();
      if (wasRunning) controller.notifyBusy();
      try {
        resumeAfterStop();
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
            const previousFiles = previous && textOf(previous) === textOf(message)
              && (previousDispatching || mergedMessages.has(previous) || [...messages.values()].includes(previous))
              ? await serialize(previous).catch(() => undefined) : undefined;
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
            if (messages.get(localId) === message) { invalidIds.add(localId); hold(`invalid:${localId}`); reportError(error); }
          }).finally(() => releaseHold(`prepare:${localId}`));
        }
        persist();
      } catch (error) {
        if (wasRunning) controller.notifyIdle();
        throw error;
      } finally {
        releaseHold("mapping");
      }
    },
    steer(message: AppendMessage) {
      // assistant-ui may route a normal running submission through steer().
      // Qone keeps that submission in FIFO; only the row's explicit Steer
      // action calls move() and sends immediately.
      adapter.enqueue(message);
    },
    move(localId: string, placement: { lane?: "queue" | "steer"; insertAfter?: string | null; insertBefore?: string | null }) {
      if (transfers.has(localId)) return;
      const message = messages.get(localId);
      const queueItemId = persistentIds.get(localId);
      if (!message || !queueItemId || steeringIds.has(localId) || editingLocalId === localId) return;
      if (placement.lane === "steer" && placement.insertAfter === null && placement.insertBefore === undefined && callbacks.isRunning()) {
        if (steeringIds.has(localId)) return;
        steeringIds.add(localId);
        const attempt = Symbol();
        steerAttempts.set(localId, attempt);
        const targetRunId = callbacks.getActiveRunId?.();
        hold(`steer:${localId}`);
        steerPositions.set(localId, positionOf(localId));
        controller.adapter.move(localId, { lane: "steer", insertAfter: controller.adapter.steerItems.at(-1)?.id ?? null });
        persist();
        steerTail = steerTail.then(async () => {
          if (holdReasons.has("suspended") || steerAttempts.get(localId) !== attempt) return true;
          const serialized = await serialize(message);
          return !holdReasons.has("suspended") && steerAttempts.get(localId) === attempt
            ? callbacks.steer(message, queueItemId, serialized, targetRunId) : true;
        })
          .catch((error) => { if (steerAttempts.get(localId) === attempt) reportError(error); return false; })
          .then((accepted) => {
            // A timeout does not prove rejection. Only a definitive result or
            // run-end event can release an input already sent over IPC.
            if (accepted === false && steerAttempts.get(localId) === attempt) settleSteer(queueItemId, false);
          });
        return;
      }
      controller.adapter.move(localId, placement);
      const time = timestamps.get(localId);
      if (time) timestamps.set(localId, { ...time, updatedAt: Date.now() });
      persist();
      releaseRetry();
    },
    async edit(localId: string, message: AppendMessage) {
      const original = messages.get(localId);
      if (original) message = { ...message, metadata: { ...message.metadata, custom: { ...message.metadata?.custom, serverIds: messageServerIds(original) ?? [] } } };
      if (!messages.has(localId) || steeringIds.has(localId) || transfers.has(localId)) return false;
      const version = (attachmentVersions.get(localId) ?? 0) + 1;
      attachmentVersions.set(localId, version);
      const preparation = `edit-prepare:${localId}:${version}`;
      hold(preparation);
      try {
        const serialized = await serialize(message);
        if (attachmentVersions.get(localId) !== version || !messages.has(localId)) return false;
        const time = timestamps.get(localId);
        if (time) timestamps.set(localId, { ...time, updatedAt: Date.now() });
        if (editingLocalId === localId) {
          reinsertEdit(localId, message, serialized);
          releaseRetry();
          return true;
        }
        messages.set(localId, message);
        attachments.set(localId, serialized);
        invalidIds.delete(localId);
        controller.adapter.edit(localId, message);
        persist();
        releaseHold(`invalid:${localId}`);
        releaseRetry();
        return true;
      } catch (error) {
        if (attachmentVersions.get(localId) !== version || !messages.has(localId)) return false;
        throw error;
      } finally { releaseHold(preparation); }
    },
    remove(localId: string) {
      if (steeringIds.has(localId) || transfers.has(localId)) return;
      controller.adapter.remove(localId);
      forget(localId);
      releaseHold(`prepare:${localId}`);
      releaseHold(`invalid:${localId}`);
      if (editingLocalId === localId) {
        editingLocalId = undefined;
        editingItem = undefined;
        editPosition = undefined;
      }
      persist();
      releaseRetry();
    },
  };

  const steerNow = (localId: string) => {
    if (!controller.adapter.items.some((item) => item.id === localId) || transfers.has(localId) || steeringIds.has(localId)) return;
    hold("send-now");
    try {
      adapter.move(localId, { lane: callbacks.isRunning() ? "steer" : "queue", insertAfter: null });
      resumeAfterStop();
    } finally { releaseHold("send-now"); }
  };

  const beginEdit = (localId: string) => {
    if (!messages.has(localId) || steeringIds.has(localId) || transfers.has(localId)) return false;
    if (editingLocalId) return false;
    const persistentId = persistentIds.get(localId);
    const item = snapshot(true).find((item) => item.id === persistentId);
    if (!item || (messages.get(localId)?.attachments?.length && !attachments.has(localId) && !invalidIds.has(localId))) return false;
    editingLocalId = localId;
    editingItem = item;
    editPosition = positionOf(localId);
    controller.adapter.remove(localId);
    persist();
    releaseHold(`invalid:${localId}`);
    return true;
  };

  const cancelEdit = () => {
    if (!editingLocalId) return;
    reinsertEdit(editingLocalId, messages.get(editingLocalId)!, attachments.get(editingLocalId) ?? [], !invalidIds.has(editingLocalId));
  };

  const transfer: QueueBundle["transfer"] = async (localId, open) => {
    if (transfers.has(localId) || steeringIds.has(localId) || editingLocalId === localId || invalidIds.has(localId)) return false;
    const message = messages.get(localId);
    const persistentId = persistentIds.get(localId);
    const item = persistentId && snapshot().find((entry) => entry.id === persistentId);
    if (!message || !item || !controller.adapter.items.some((entry) => entry.id === localId)) return false;
    const transferGeneration = generation;
    const position = positionOf(localId);
    transfers.set(localId, { item, position });
    controller.adapter.remove(localId);
    persist();
    let committed = false;
    try { committed = await open(item); return committed; }
    finally {
      if (generation !== transferGeneration) return committed;
      hold(`transfer-restore:${localId}`);
      try {
        transfers.delete(localId);
        if (committed) forget(localId);
        else {
          const time = timestamps.get(localId)!;
          const before = controller.adapter.items;
          controller.adapter.enqueue(message);
          const nextId = findNewId(before, controller.adapter.items)!;
          forget(localId);
          messages.set(nextId, message);
          persistentIds.set(nextId, item.id);
          attachments.set(nextId, item.attachments ?? []);
          timestamps.set(nextId, time);
          for (const anchors of [...steerPositions.values(), ...[...transfers.values()].map((entry) => entry.position), ...(editPosition ? [editPosition] : [])]) {
            anchors.before = anchors.before.map((id) => id === localId ? nextId : id);
            anchors.after = anchors.after.map((id) => id === localId ? nextId : id);
          }
          restorePosition(nextId, position);
        }
        persist();
      } finally { releaseHold(`transfer-restore:${localId}`); }
    }
  };

  const restore = (items: QueueItemInfo[], editingItemId?: string) => {
    restoring = true;
    generation++;
    steerTail = Promise.resolve();
    pendingSends.clear();
    dispatchingMessage = undefined;
    const stopped = holdReasons.has("stopped");
    hold("restore");
    holdReasons.clear();
    holdReasons.add("restore");
    // A reconnect must not undo the user's stop.
    if (stopped) holdReasons.add("stopped");
    let normalizedSteer = false;
    try {
      controller.clear();
      messages.clear();
      persistentIds.clear();
      attachments.clear();
      timestamps.clear();
      attachmentVersions.clear();
      transfers.clear();
      steeringIds.clear();
      steerAttempts.clear();
      invalidIds.clear();
      steerPositions.clear();
      editingLocalId = undefined;
      editingItem = undefined;
      editPosition = undefined;
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
      // Detach before releasing the restore hold, so a reconnect cannot send
      // the original while its modified draft is still in the composer.
      const editingId = editingItemId ? [...persistentIds].find(([, id]) => id === editingItemId)?.[0] : undefined;
      if (editingId) beginEdit(editingId);
    } finally {
      restoring = false;
      if (!callbacks.isRunning()) { controller.notifyIdle(); releaseHold("restore"); }
      if (normalizedSteer) persist();
    }
  };

  const settleSteer = (persistentId: string, delivered: boolean) => {
    const localId = [...persistentIds.entries()].find(([, id]) => id === persistentId)?.[0];
    if (!localId || !steeringIds.has(localId)) return;
    if (delivered) {
      controller.adapter.remove(localId);
      forget(localId);
    } else {
      restorePosition(localId, steerPositions.get(localId) ?? { before: [], after: [] });
    }
    steerPositions.delete(localId);
    steerAttempts.delete(localId);
    steeringIds.delete(localId);
    persist();
    releaseHold(`steer:${localId}`);
  };

  return {
    adapter,
    controller,
    steerNow,
    restore,
    beginEdit,
    cancelEdit,
    releaseIdle: () => { releaseHold("restore"); releaseHold("send-failed"); },
    suspend: () => hold("suspended"),
    pauseAfterStop: () => { rememberPaused(true); hold("stopped"); },
    edit: adapter.edit,
    remove: adapter.remove,
    settleSteer,
    settleSend,
    getPersistentId: (localId) => persistentIds.get(localId),
    getLocalId: (persistentId: string) => [...persistentIds.entries()].find(([, id]) => id === persistentId)?.[0],
    getMessage: (localId) => messages.get(localId),
    getSnapshot: () => snapshot(true),
    transfer,
    hasTransfers: () => transfers.size > 0,
    resume: () => releaseHold("suspended"),
    // Read from the local queue, not the runtime snapshot, so a freshly queued
    // item is editable at once. Undefined while its attachments are still
    // being serialized, so an edit never starts from an incomplete list.
    getItem: (persistentId: string) => {
      const localId = [...persistentIds.entries()].find(([, id]) => id === persistentId)?.[0];
      if (!localId || ((messages.get(localId)?.attachments?.length ?? 0) > 0 && !attachments.has(localId) && !invalidIds.has(localId))) return undefined;
      // Recompute the scheduled position from the surviving anchors. A
      // neighbor can be removed or steered while the composer owns this edit,
      // so the position captured when editing began is not a stable UI index.
      return snapshot(true).find((item) => item.id === persistentId);
    },
  };
}
