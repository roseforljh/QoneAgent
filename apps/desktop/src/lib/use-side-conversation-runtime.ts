import { useConversationStore } from "./conversation-context";
import { useShallow } from "zustand/react/shallow";
import { useConversationMessages } from "./use-conversation-messages";
import { createSubagentImagesSelector } from "./subagent-images";
import { addComposerHistory } from "./composer-history";
import { useEffect, useMemo } from "react";
import { useExternalStoreRuntime, type AppendMessage } from "@assistant-ui/react";
import { sameUserInput } from "@qone/protocol";
import { useStore } from "../store";
import { sessionStore } from "./session-execution-state";
import { createQoneMessageQueue, getQoneMessageQueue } from "./qone-message-queue";
import { bindSessionQueue, hydrateSessionQueue } from "./session-queue-lifecycle";
import { convertedMessage } from "./runtime-message-converter";
import { QoneAttachmentAdapter } from "./file-attachment-adapter";
import { extractComposerPrompt } from "./composer-prompt";
import { serializeMessageAttachments } from "./message-attachments";
import { localizeError } from "./error-localization";
import { bindComposerDrafts, composerDrafts } from "./composer-drafts";
import { queueMessageDraft } from "./queue-composer-edit";
import { useSteeringMessages } from "./use-steering-messages";
import { useMessageQueueAdapter } from "./use-message-queue-adapter";

const attachmentAdapter = new QoneAttachmentAdapter();

export function useSideConversationRuntime(sessionId: string) {
  const state = useConversationStore(useShallow((state) => ({
    queueLoadedSessionId: state.queueLoadedSessionId,
    queueItems: state.queueItems,
    editingQueueItem: state.editingQueueItem,
    activeRunId: state.activeRunId,
    messages: state.messages,
    streaming: state.streaming,
    streamingParts: state.streamingParts,
    running: state.running,
    modelConfigs: state.modelConfigs,
    selectedModelId: state.selectedModelId,
    chatRunError: state.chatRunError,
    toolCalls: state.toolCalls,
  })));
  const connected = useStore((global) => global.connected);
  const workspaceReady = useStore((global) => {
    const workspaceId = global.sideChats[sessionId]?.workspaceId;
    return Boolean(workspaceId && global.workspaces.some((workspace) => workspace.id === workspaceId));
  });
  const ready = connected && workspaceReady && state.queueLoadedSessionId === sessionId;
  const owner = useMemo(() => sessionStore(useStore, sessionId), [sessionId]);
  const submit = (message: AppendMessage, queueItemId: string | undefined, attachments: Awaited<ReturnType<typeof serializeMessageAttachments>>) => {
    const prompt = extractComposerPrompt(message);
    if (prompt.text.trim()) addComposerHistory(sessionId, prompt.text);
    useStore.getState().runAgent(prompt.text, undefined, attachments, queueItemId, prompt.goal, sessionId, prompt.quote);
  };
  const queue = useMemo(() => ready ? getQoneMessageQueue(sessionId) ?? createQoneMessageQueue({
    sessionId,
    isRunning: () => owner.getState().running || Boolean(useStore.getState().compactionStatuses[sessionId]),
    getActiveRunId: () => owner.getState().activeRunId,
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
      const prompt = extractComposerPrompt(message);
      if (prompt.text.trim()) addComposerHistory(sessionId, prompt.text);
      return useStore.getState().steerAgent({ sessionId, runId, queueItemId, message: prompt.text, attachments, quote: prompt.quote });
    },
    sync: (items) => { void useStore.getState().send({ type: "queue.sync", requestId: crypto.randomUUID(), sessionId, items }); },
    onError: (message) => useStore.setState({ lastError: message }),
  }) : null, [sessionId, ready, owner]);
  useEffect(() => {
    if (queue && state.queueLoadedSessionId === sessionId) hydrateSessionQueue(queue, state.queueItems, state.editingQueueItem?.id);
  }, [queue, sessionId, state.queueLoadedSessionId, state.queueItems, state.editingQueueItem?.id]);
  useEffect(() => { if (queue) bindSessionQueue(sessionId, queue); }, [queue, sessionId]);
  const queueAdapter = useMessageQueueAdapter(queue);
  const steers = useSteeringMessages(queue, queueAdapter, state.queueItems, state.activeRunId);
  const selectChildImages = useMemo(createSubagentImagesSelector, []);
  const childImagesByRun = useConversationStore(selectChildImages);
  const messages = useConversationMessages({
    messages: state.messages,
    streaming: state.streaming,
    streamingParts: state.streamingParts,
    running: state.running,
    activeRunId: state.activeRunId,
    currentSessionId: sessionId,
    chatRunError: state.chatRunError,
    toolCalls: state.toolCalls,
    childImagesByRun,
    selectedModel: state.modelConfigs.find((model) => model.id === state.selectedModelId),
  }, steers);
  const runtime = useExternalStoreRuntime({
    messages, isRunning: state.running, isDisabled: !ready, convertMessage: convertedMessage,
    onNew: async (message) => {
      const localId = state.editingQueueItem && queue?.getLocalId(state.editingQueueItem.id);
      if (localId && queue) {
        if (await queue.edit(localId, message)) owner.setState({ editingQueueItem: undefined });
        return;
      }
      submit(message, undefined, await serializeMessageAttachments(message));
    },
    onReload: async (parentId) => {
      if (!parentId) return;
      const state = owner.getState();
      const source = state.messages.find((message) => message.id === parentId && message.role === "user");
      if (source) state.runAgent(source.content, source.id, source.attachments, undefined, Boolean(source.goalId), sessionId, source.quote);
    },
    onEdit: async (message) => {
      const sourceId = message.sourceId;
      const current = owner.getState();
      if (!sourceId || current.running) return;
      const source = current.messages.find((item) => item.id === sourceId && item.role === "user");
      const prompt = extractComposerPrompt(message);
      let attachments: Awaited<ReturnType<typeof serializeMessageAttachments>>;
      try { attachments = await serializeMessageAttachments(message); }
      catch (error) { useStore.setState({ lastError: String(error) }); throw error; }
      if (!prompt.text.trim() && attachments.length === 0) return;
      if (prompt.goal && !prompt.text.trim()) return;
      if (prompt.text.trim()) addComposerHistory(sessionId, prompt.text);
      current.runAgent(prompt.text, sourceId, attachments, undefined, prompt.goal || Boolean(source?.goalId), sessionId, prompt.quote ?? source?.quote);
    },
    onCancel: async () => useStore.getState().stopAgent(sessionId),
    adapters: { attachments: attachmentAdapter },
    queue: queueAdapter,
  });
  useEffect(() => bindComposerDrafts(runtime, sessionId, () => Boolean(useStore.getState().sideChats[sessionId])), [runtime, sessionId]);
  return runtime;
}
