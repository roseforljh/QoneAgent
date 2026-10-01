import { useEffect, useMemo, useState } from "react";
import { useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { sameUserInput } from "@qone/protocol";
import { useStore, type ChatMessage } from "../store";
import { emptySessionState, sessionStore } from "./session-execution-state";
import { createQoneMessageQueue, getQoneMessageQueue } from "./qone-message-queue";
import { bindSessionQueue, hydrateSessionQueue } from "./session-queue-lifecycle";
import { createMessageConverter, convertedMessage } from "./runtime-message-converter";
import { QoneAttachmentAdapter } from "./file-attachment-adapter";
import { extractComposerPrompt } from "./composer-prompt";
import { serializeMessageAttachments } from "./message-attachments";
import { localizeError } from "./error-localization";
import { localImagePreview } from "./local-image-preview";
import { bindComposerDrafts, composerDrafts } from "./composer-drafts";
import { queueMessageDraft } from "./queue-composer-edit";
import { insertChatRunErrorMessage } from "./chat-run-error-message";
import { useLocale } from "../localization";
import { appendSteeringMessages, useSteeringMessages } from "./use-steering-messages";
import { useMessageQueueAdapter } from "./use-message-queue-adapter";

const empty = emptySessionState();
const attachmentAdapter = new QoneAttachmentAdapter();

export function useSideConversationRuntime(sessionId: string) {
  const { t } = useLocale();
  const state = useStore((global) => global.backgroundSessions[sessionId]) ?? empty;
  const connected = useStore((global) => global.connected);
  const workspaceReady = useStore((global) => {
    const workspaceId = global.sideChats[sessionId]?.workspaceId;
    return Boolean(workspaceId && global.workspaces.some((workspace) => workspace.id === workspaceId));
  });
  const ready = connected && workspaceReady && state.queueLoadedSessionId === sessionId;
  const owner = useMemo(() => sessionStore(useStore, sessionId), [sessionId]);
  const submit = (message: AppendMessage, queueItemId: string | undefined, attachments: Awaited<ReturnType<typeof serializeMessageAttachments>>) => {
    const prompt = extractComposerPrompt(message);
    useStore.getState().runAgent(prompt.text, undefined, attachments, queueItemId, prompt.goal, sessionId);
  };
  const queue = useMemo(() => ready ? getQoneMessageQueue(sessionId) ?? createQoneMessageQueue({
    sessionId,
    isRunning: () => owner.getState().running,
    getActiveRunId: () => owner.getState().activeRunId,
    getFollowUpQueueMode: () => useStore.getState().followUpQueueMode,
    isDuplicate: (message, attachments) => {
      const state = owner.getState();
      const previous = [...state.messages].reverse().find((item) => item.role === "user");
      return state.running && Boolean(previous && sameUserInput(previous, { content: extractComposerPrompt(message).text, attachments }));
    },
    editPending: (message) => {
      const editing = owner.getState().editingQueueItem;
      const activeQueue = getQoneMessageQueue(sessionId);
      const localId = editing && activeQueue?.getLocalId(editing.id);
      if (!editing || !activeQueue || !localId) return false;
      void activeQueue.edit(localId, message).then((saved) => {
        if (saved) owner.setState({ editingQueueItem: undefined });
      }).catch((error) => {
        if (!composerDrafts.get(sessionId)) composerDrafts.set(sessionId, queueMessageDraft(message));
        useStore.setState({ lastError: localizeError(error) });
      });
      return true;
    },
    send: (message, id, attachments) => submit(message, id, attachments),
    steer: (message, queueItemId, attachments, runId) => {
      if (!runId || !owner.getState().running || owner.getState().activeRunId !== runId) return Promise.resolve(false);
      return useStore.getState().steerAgent({ sessionId, runId, queueItemId, message: extractComposerPrompt(message).text, attachments });
    },
    sync: (items) => { void useStore.getState().send({ type: "queue.sync", requestId: crypto.randomUUID(), sessionId, items }); },
    onError: (message) => useStore.setState({ lastError: message }),
  }) : null, [sessionId, ready, owner]);
  useEffect(() => {
    if (queue && state.queueLoadedSessionId === sessionId) hydrateSessionQueue(queue, state.queueItems, state.editingQueueItem?.id);
  }, [queue, sessionId, state.queueLoadedSessionId, state.queueItems, state.editingQueueItem?.id]);
  useEffect(() => { if (queue) bindSessionQueue(sessionId, queue); }, [queue, sessionId]);
  const [previews, setPreviews] = useState<Record<string, string>>({});
  useEffect(() => {
    let active = true;
    const paths = [...new Set(state.messages.flatMap((message) => message.attachments?.flatMap((attachment) => attachment.type === "image" && attachment.localPath ? [attachment.localPath] : []) ?? []))];
    void Promise.all(paths.map(async (path) => {
      try { return [path, await localImagePreview(path)] as const; } catch { return undefined; }
    })).then((entries) => { if (active) setPreviews(Object.fromEntries(entries.filter((entry) => entry !== undefined))); });
    return () => { active = false; };
  }, [state.messages]);
  const convert = useMemo(createMessageConverter, []);
  const queueAdapter = useMessageQueueAdapter(queue);
  const steers = useSteeringMessages(queue, queueAdapter, state.queueItems, state.activeRunId);
  const messages = useMemo(() => {
    const history = appendSteeringMessages(state.messages, steers);
    const source: ChatMessage[] = state.running ? [...history, {
      id: "streaming", role: "assistant", content: state.streaming, parts: state.streamingParts,
      runId: state.activeRunId, createdAt: state.messages.at(-1)?.createdAt,
    }] : state.chatRunError ? insertChatRunErrorMessage(history, state.chatRunError, `${t("chat.runFailed")}\n${state.chatRunError.detail}`) : history;
    return source.map((message) => convert(message, {
      imagePreviews: previews, toolCallsByRun: new Map(), imageWindows: new Map(), childImagesByRun: new Map(), running: state.running, imageModel: false,
    }));
  }, [state.messages, steers, state.running, state.streaming, state.streamingParts, state.activeRunId, state.chatRunError, previews, convert, t]);
  const runtime = useExternalStoreRuntime({
    messages, isRunning: state.running, convertMessage: convertedMessage,
    onNew: async (message) => {
      const localId = state.editingQueueItem && queue?.getLocalId(state.editingQueueItem.id);
      if (localId && queue) {
        if (await queue.edit(localId, message)) owner.setState({ editingQueueItem: undefined });
        return;
      }
      submit(message, undefined, await serializeMessageAttachments(message));
    },
    onCancel: async () => useStore.getState().stopAgent(sessionId),
    adapters: { attachments: attachmentAdapter },
    queue: queueAdapter,
  });
  useEffect(() => bindComposerDrafts(runtime, sessionId, () => Boolean(useStore.getState().sideChats[sessionId])), [runtime, sessionId]);
  return runtime;
}
