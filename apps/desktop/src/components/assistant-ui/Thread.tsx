import { useConversationStore, useConversationStoreApi } from "../../lib/conversation-context";
import { conversationSession } from "../../lib/session-execution-state";
import { localizeError } from "../../lib/error-localization";
import { ComposerAttachments, ComposerAddAttachment } from "./elements/attachment.aui";
import { UserMessage, UserMessageContent } from "./user-message";
import { ComposerToolsPopover, type ComposerTool } from "./composer-tools";
import { ComposerTriggers } from "./composer-triggers";
import { ComposerEditorBridge, type ComposerMentionControls, type InsertComposerCommand, type InsertComposerTool } from "./composer-editor-bridge";
import type { ComposerCommand } from "../../lib/composer-tool-editor";
import { ComposerActionGlyph } from "./composer-action-glyph";
import { LongPasteAttachmentPlugin } from "./long-paste-attachment";
import { ComposerLinkNode } from "./composer-link-node";
import { ComposerLinkPastePlugin } from "./composer-link-paste";
import { composerLinkFormatter } from "./composer-link-formatter";
import { ComposerDirectiveChip } from "./composer-link-chip";
import { ComposerLinkOptionsPlugin } from "./composer-link-options";
import { ComposerUnlinkedNode } from "./composer-unlinked-node";
import "./composer-links.css";
import { AssistantParts } from "./assistant-parts";
import { AssistantMessageLayout } from "./assistant-message-layout";
import { GeneratedMediaArtifacts } from "./generated-media-artifacts";
import { MessagePair } from "./elements/message-pair";
import { DaySeparatorMarker } from "./elements/day-separator";
import { chatRunErrorMessageId } from "../../lib/chat-run-error-message";
import { pairMessageIds } from "./message-pairing";
import { messageDaySeparators } from "./message-day-separators";
import { MessageSourcesView } from "./message-sources-view";
import { AssistantContext, AssistantMemoryChips } from "./assistant-context";
import { TooltipIconButton } from "./tooltip-icon-button";
import { AssistantMessageActions, UserMessageActions } from "./message-actions";
import { SelectedTextActions } from "./selected-text-actions";
import { ComposerQuote } from "./composer-quote";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { ModelPicker } from "./model-picker";
import { RunOptionsPopover } from "./run-options-popover";
import { ConversationMapAui } from "./elements/conversation-map.aui";
import { ContextCompactionMarker } from "./context-compaction-marker";
import { RunFileChangesSummary } from "./run-file-changes-summary";
import { ComposerLoadingSkeleton, ConversationLoadingSkeleton } from "./loading-skeleton";
import { ThreadScrollFollower } from "./thread-scroll-follower";
import { ThreadScrollToBottom } from "./thread-scroll-to-bottom";
import "./thread-viewport.css";
import "./composer-queue.css";
import "./composer-actions.css";
import { ComposerQueue } from "./composer-queue";
import { useStore } from "../../store";
import { messageById } from "../../lib/store-indexes";
import { createMessageStructureSelector } from "../../lib/thread-message-structure";
import { getThreadScrollState, pruneThreadScrollStates } from "../../lib/thread-scroll-state";
import { useLocale } from "../../localization";
import { pickNativeAttachmentFiles, pickNativeAttachmentFolder, useNativeFileDrop } from "../../lib/native-file-drop";
import { hasTauriBridge } from "../../store";
import { getQoneMessageQueue } from "../../lib/qone-message-queue";
import { ComposerQueueEnterPlugin } from "./composer-queue-enter";
import { ComposerHistoryPlugin } from "./composer-history";
import {
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import type { ThreadMessage } from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import {
  CornerDownRightIcon,
  MicIcon,
  RefreshCwIcon,
  SquareIcon,
  FolderPlusIcon,
  Loader2Icon,
  TargetIcon,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type FC, type RefObject } from "react";

export const Thread: FC<{ children?: ReactNode }> = ({ children }) => {
  const { locale, t } = useLocale();
  const sessions = useConversationStore((state) => state.sessions);
  const sideChats = useConversationStore((state) => state.sideChats);
  const session = useConversationStore(conversationSession);
  const workspaces = useConversationStore((state) => state.workspaces);
  const currentSessionId = useConversationStore((state) => state.currentSessionId);
  const draftWorkspaceId = useConversationStore((state) => state.draftWorkspaceId);
  const creatingSession = useConversationStore((state) => state.creatingSession);
  const sessionsLoaded = useConversationStore((state) => state.sessionsLoaded);
  const workspacesLoaded = useConversationStore((state) => state.workspacesLoaded);
  const messagesLoadingSessionId = useConversationStore((state) => state.messagesLoadingSessionId);
  useEffect(() => {
    if (sessionsLoaded) pruneThreadScrollStates([...sessions.map((session) => session.id), ...Object.keys(sideChats)]);
  }, [sessions, sideChats, sessionsLoaded]);
  const messageStructure = useMemo(createMessageStructureSelector, []);
  const threadMessages = useAuiState((state) => messageStructure(state.thread.messages));
  const chatRunError = useConversationStore((state) => state.chatRunError);
  const compactions = useConversationStore((state) => state.compactions);
  const compactionStatus = useConversationStore((state) => state.currentSessionId ? state.compactionStatuses[state.currentSessionId] : undefined);
  const autoCompactionStatus = useConversationStore((state) => state.currentSessionId ? state.autoCompactionStatuses[state.currentSessionId] : undefined);
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const nextMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const timer = setTimeout(() => setToday(new Date()), nextMidnight.getTime() - Date.now());
    return () => clearTimeout(timer);
  }, [today]);
  const pairableMessages = threadMessages as unknown as Parameters<typeof pairMessageIds>[0];
  const pairedUserIdByAssistant = useMemo(() => pairMessageIds(pairableMessages), [pairableMessages]);
  const pairedUserIds = useMemo(() => new Set(pairedUserIdByAssistant.values()), [pairedUserIdByAssistant]);
  const compactionMarkersByMessage = useMemo(() => {
    const visibleAnchorByUser = new Map([...pairedUserIdByAssistant].map(([assistantId, userId]) => [userId, assistantId]));
    const visibleMessageIds = new Set(threadMessages.map((message) => message.id));
    type Marker = { id: string; status: "running" | "completed" | "interrupted"; source: "manual" | "automatic"; startedAt: number };
    const after = new Map<string, Marker[]>();
    const between = new Map<string, Marker[]>();
    for (const marker of [
      ...compactions.filter((item) => item.partIndex === undefined || !item.runId).map((item) => ({ id: item.id, throughMessageId: item.throughMessageId, startedAt: item.createdAt, status: item.status, source: item.source })),
      ...(compactionStatus ? [{ id: compactionStatus.requestId, throughMessageId: compactionStatus.throughMessageId, startedAt: compactionStatus.startedAt, status: "running" as const, source: "manual" as const }] : []),
      ...(autoCompactionStatus && autoCompactionStatus.partIndex === undefined ? [{ id: autoCompactionStatus.id, throughMessageId: autoCompactionStatus.throughMessageId, startedAt: autoCompactionStatus.startedAt, status: "running" as const, source: "automatic" as const }] : []),
    ]) {
      const pairedAssistantId = visibleAnchorByUser.get(marker.throughMessageId);
      const anchorId = pairedAssistantId ?? marker.throughMessageId;
      if (!visibleMessageIds.has(anchorId)) continue;
      const target = pairedAssistantId ? between : after;
      target.set(anchorId, [...(target.get(anchorId) ?? []), marker]);
    }
    return { after, between };
  }, [compactions, compactionStatus, autoCompactionStatus, pairedUserIdByAssistant, threadMessages]);
  const errorMessageId = chatRunError && chatRunError.sessionId === currentSessionId ? chatRunErrorMessageId(chatRunError.userMessageId) : undefined;
  const latestAssistantId = useMemo(
    () => [...threadMessages].reverse().find((message) => message.role === "assistant" && message.id !== errorMessageId)?.id,
    [threadMessages, errorMessageId],
  );
  const dayMessages = threadMessages as unknown as Parameters<typeof messageDaySeparators>[0];
  const daySeparators = useMemo(() => messageDaySeparators(dayMessages, pairedUserIdByAssistant, today), [dayMessages, pairedUserIdByAssistant, today]);
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }), [locale]);
  const messageRenderState = useMemo(() => ({
    sessionBoundary: session?.sideChat?.boundaryMessageId,
    pairedUserIds,
    daySeparators,
    pairedUserIdByAssistant,
    latestAssistantId,
    lastMessageId: threadMessages.at(-1)?.id,
    compactionMarkersByMessage,
    dayFormatter,
  }), [session?.sideChat?.boundaryMessageId, pairedUserIds, daySeparators, pairedUserIdByAssistant,
    latestAssistantId, threadMessages, compactionMarkersByMessage, dayFormatter]);
  const renderMessage = useCallback(({ message }: { message: ThreadMessage }) => {
    const state = messageRenderState;
    if (message.id === state.sessionBoundary) return <div className="mx-auto w-full q-thread-content border-y border-border/60 py-3 text-center text-xs text-muted-foreground">{t("chat.sideChatBoundary")}</div>;
    if (message.role === "user" && state.pairedUserIds.has(message.id)) return null;
    const date = state.daySeparators.get(message.id);
    return (
      <div
        className="q-message-block flex w-full flex-col gap-4"
        data-message-block
        data-turn-id={message.role === "user" ? message.id : state.pairedUserIdByAssistant.get(message.id)}
        data-static-turn={message.id !== state.latestAssistantId && message.id !== state.lastMessageId ? "" : undefined}
      >
        {message.role === "user"
          ? <UserMessage />
          : <AssistantMessage
            userMessageId={state.pairedUserIdByAssistant.get(message.id)}
            showLatestExtras={message.id === state.latestAssistantId}
            betweenContent={state.compactionMarkersByMessage.between.get(message.id)?.map((marker) => (
              <ContextCompactionMarker key={marker.id} status={marker.status} source={marker.source} startedAt={marker.startedAt} />
            ))}
          />}
        {date && <DaySeparatorMarker day={state.dayFormatter.format(date)} className="mx-auto q-thread-content" />}
        {state.compactionMarkersByMessage.after.get(message.id)?.map((marker) => (
          <ContextCompactionMarker key={marker.id} status={marker.status} source={marker.source} startedAt={marker.startedAt} />
        ))}
      </div>
    );
  }, [t, messageRenderState]);
  const canChat = (() => {
    return Boolean(
      (session?.workspaceId && workspaces.some((workspace) => workspace.id === session.workspaceId)) ||
      (draftWorkspaceId && workspaces.some((workspace) => workspace.id === draftWorkspaceId)),
    );
  })();
  // Project file loading must not unmount the selected conversation's viewport.
  const conversationLoading = !sessionsLoaded || !workspacesLoaded || Boolean(
    currentSessionId && messagesLoadingSessionId === currentSessionId,
  );
  const messageListRef = useRef<HTMLDivElement>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  return (
    <ThreadPrimitive.Root
      ref={threadRef}
      data-conversation-id={currentSessionId}
      className="aui-root aui-thread-root relative bg-background text-foreground flex h-full flex-col items-stretch px-4 [--q-chat-bg:var(--background)]"
      style={{
        ["--composer-bg" as string]: "var(--q-surface)",
        ["--composer-radius" as string]: "var(--radius-thread)",
      }}
    >
      {canChat && <SelectedTextActions key={currentSessionId} scopeRef={threadRef} />}
      {conversationLoading ? (
        <>
          <ConversationLoadingSkeleton />
          <div className="mx-auto w-full q-composer-content px-4 pb-2">
            {canChat ? <Composer placeholder={t("chat.placeholder")} /> : <ComposerLoadingSkeleton />}
          </div>
        </>
      ) : <>
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <EmptyState canChat={canChat} creatingSession={creatingSession} />
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport
          key={currentSessionId}
          turnAnchor="top"
          scrollRestoration={getThreadScrollState(currentSessionId)}
          scrollToBottomOnInitialize={false}
          scrollToBottomOnRunStart={false}
          scrollToBottomOnThreadSwitch={false}
          className="aui-viewport flex min-h-0 grow flex-col overflow-y-auto"
        >
          <ThreadScrollFollower contentRef={messageListRef}>
          <ConversationMapAui />
          <div ref={messageListRef} className="q-message-list relative flex w-full min-w-0 shrink-0 flex-col gap-5 pb-7">
            <div data-conversation-rail-content aria-hidden="true" className="pointer-events-none invisible absolute inset-x-0 top-0 mx-auto h-0 w-full q-thread-content" />
            <ThreadPrimitive.Messages>
              {renderMessage}
            </ThreadPrimitive.Messages>
          </div>
          <div data-thread-end-content className="mx-auto w-full shrink-0 q-thread-content pb-7 empty:hidden">{children}</div>

          <ThreadPrimitive.ViewportFooter data-thread-scroll-footer className="q-chat-footer sticky bottom-0 z-20 mt-auto flex w-full shrink-0 flex-col overflow-visible">
            <ThreadScrollToBottom />
            {canChat && <RunFileChangesSummary />}
            <div className="q-chat-composer-anchor relative w-full pb-2">
              <div className="relative mx-auto w-full q-composer-content">
                {canChat ? <Composer placeholder={t("chat.placeholder")} /> : <ProjectImportPrompt compact />}
              </div>
            </div>
          </ThreadPrimitive.ViewportFooter>
          </ThreadScrollFollower>
        </ThreadPrimitive.Viewport>
      </AuiIf>
      </>}
    </ThreadPrimitive.Root>
  );
};
const ProjectImportPrompt: FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useLocale();
  const chooseWorkspace = useConversationStore((state) => state.chooseWorkspace);
  return <div className={cn("q-project-required", compact && "q-project-required-compact")}>
    {!compact && <><p className="q-project-required-title">{t("chat.projectRequired")}</p><p className="q-project-required-description">{t("chat.projectRequiredDescription")}</p></>}
    <button type="button" className="q-project-import-button" onClick={chooseWorkspace}><FolderPlusIcon className="size-4" />{t("chat.importProject")}</button>
  </div>;
};

const SessionCreatingState: FC = () => {
  const { t } = useLocale();
  return <div className="flex grow flex-col items-center justify-center px-4 pb-[16vh]">
    <div className="flex flex-col items-center gap-3 text-muted-foreground">
      <Loader2Icon className="size-6 animate-spin" aria-hidden="true" />
      <p className="text-sm">{t("chat.creatingSession")}</p>
    </div>
  </div>;
};

const EmptyState: FC<{ canChat: boolean; creatingSession: boolean }> = ({ canChat, creatingSession }) => {
  const { t } = useLocale();
  if (creatingSession) return <SessionCreatingState />;
  return (
    <div className="flex grow flex-col items-center justify-center px-4 pb-[16vh]">
      <div className="mx-auto flex w-full q-composer-content flex-col items-stretch gap-5">
        {canChat ? <>
          <p className="text-center text-xl leading-7 font-normal text-foreground">{t("chat.welcome")}</p>
          <Composer placeholder={t("chat.placeholder")} />
        </> : <ProjectImportPrompt />}
      </div>
    </div>
  );
};

const composerInputClass =
  "aui-composer-input [&_.aui-lexical-placeholder]:text-muted-foreground/60 relative max-h-48 min-h-11 w-full resize-none bg-transparent px-3 py-0 text-sm leading-5 outline-none [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-3 [&_.aui-lexical-placeholder]:py-0";
const composerNodes = [ComposerLinkNode, ComposerUnlinkedNode] as const;

const Composer: FC<{ placeholder: string }> = ({ placeholder }) => {
  const aui = useAui();
  const owner = useConversationStoreApi();
  const session = useConversationStore(conversationSession);
  const { t } = useLocale();
  const sessionId = useConversationStore((state) => state.currentSessionId);
  const compactSession = useConversationStore((state) => state.compactSession);
  const compacting = useConversationStore((state) => Boolean(state.currentSessionId && state.compactionStatuses[state.currentSessionId]));
  const editingQueueItem = useConversationStore((state) => state.editingQueueItem);
  const insertToolRef = useRef<InsertComposerTool | null>(null);
  const insertCommandRef = useRef<InsertComposerCommand | null>(null);
  const mentionControlsRef = useRef<ComposerMentionControls | null>(null);
  const closeMentionRef = useRef<(() => void) | null>(null);
  const mentionWasOpen = useRef(false);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [slashOpen, setSlashOpen] = useState(false);
  const shellRef = useRef<HTMLDivElement>(null);
  const onNativeFiles = useCallback(async (files: globalThis.File[]) => {
    await Promise.all(files.map(async (file) => {
      try {
        await aui.composer.addAttachment(file);
      } catch {
        // The composer runtime emits composer.attachmentAddError for rejected files.
      }
    }));
  }, [aui]);
  useNativeFileDrop(shellRef, onNativeFiles);
  const onEditorReady = useCallback((insert: InsertComposerTool | null) => { insertToolRef.current = insert; }, []);
  const onCommandReady = useCallback((insert: InsertComposerCommand | null) => { insertCommandRef.current = insert; }, []);
  const onCommandSelect = useCallback((command: ComposerCommand) => { insertCommandRef.current?.(command); }, []);
  const onToolSelect = useCallback((tool: ComposerTool) => {
    if (tool.id === "attachment") {
      if (hasTauriBridge()) void pickNativeAttachmentFiles().then(onNativeFiles).catch((error) => {
        useStore.setState({ lastError: localizeError(error) });
      });
      else shellRef.current?.querySelector<HTMLButtonElement>(".aui-composer-add-attachment")?.click();
    }
    else if (tool.id === "folder") void pickNativeAttachmentFolder().then(onNativeFiles).catch((error) => {
      useStore.setState({ lastError: localizeError(error) });
    });
    else if (tool.id === "compact") compactSession();
    else insertToolRef.current?.({ id: tool.id, label: tool.label });
  }, [compactSession, onNativeFiles]);
  const onMentionStateChange = useCallback((open: boolean, close: () => void) => {
    closeMentionRef.current = close;
    if (mentionWasOpen.current && !open) mentionControlsRef.current?.cancel();
    mentionWasOpen.current = open;
    setMentionOpen(open);
  }, []);
  const onMentionToggleReady = useCallback((controls: ComposerMentionControls | null) => { mentionControlsRef.current = controls; }, []);
  const toggleMention = useCallback(() => {
    if (mentionOpen) {
      if (!mentionControlsRef.current?.cancel()) closeMentionRef.current?.();
    } else mentionControlsRef.current?.open();
  }, [mentionOpen]);

  return (
    <>
    <GoalStatusBar />
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerQueue allowSideChat={!session?.sideChat} />
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          ref={shellRef}
          data-slot="aui_composer-shell"
          className="q-composer-shell relative z-10 flex w-full cursor-text flex-col gap-0 rounded-(--composer-radius) bg-(--composer-bg) p-0 transition-[border-color,box-shadow] data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          {editingQueueItem && (
            <div className="flex items-center justify-between px-2.5 py-1 text-xs text-muted-foreground" role="status">
              <span>{t("chat.queueEditing")}</span>
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-foreground/10" onClick={() => { void aui.composer().reset(); owner.setState({ editingQueueItem: undefined }); if (sessionId) getQoneMessageQueue(sessionId)?.cancelEdit(); }}>{t("common.cancel")}</button>
            </div>
          )}
          <ComposerAttachments><ComposerQuote /></ComposerAttachments>
          <ComposerAddAttachment hidden />
          <LexicalComposerInput nodes={composerNodes} formatter={composerLinkFormatter} autoFocus submitMode="none" placeholder={placeholder} className={composerInputClass} directiveChip={ComposerDirectiveChip}>
            <ComposerEditorBridge onReady={onEditorReady} onCommandReady={onCommandReady} onMentionToggleReady={onMentionToggleReady} />
            <LongPasteAttachmentPlugin />
            <ComposerLinkPastePlugin />
            <ComposerLinkOptionsPlugin />
            <ComposerQueueEnterPlugin menuOpen={mentionOpen || slashOpen} compacting={compacting} />
            <ComposerHistoryPlugin menuOpen={mentionOpen || slashOpen} />
          </LexicalComposerInput>
          <ComposerTriggers onToolSelect={onToolSelect} onCommandSelect={onCommandSelect} onMentionStateChange={onMentionStateChange} onSlashStateChange={setSlashOpen} />
          <ComposerAction mentionOpen={mentionOpen} onToggleMention={toggleMention} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </ComposerPrimitive.Root>
    </>
  );
};

const GoalStatusBar: FC = () => {
  const { t } = useLocale();
  const goal = useConversationStore((state) => state.goal);
  const pause = useConversationStore((state) => state.pauseGoal);
  const resume = useConversationStore((state) => state.resumeGoal);
  const clear = useConversationStore((state) => state.clearGoal);
  if (!goal) return null;
  const status = goal.waitingReason ? t("goal.waiting") : goal.status === "active" ? t("goal.active") : goal.status === "paused" ? t("goal.paused") : goal.status === "blocked" ? t("goal.blocked") : t("goal.complete");
  return <div className="mx-auto mb-2 flex w-full q-composer-content items-center gap-2 rounded-xl border border-foreground/10 bg-muted/30 px-3 py-2 text-xs" role="status">
    <span className="flex min-w-0 flex-1 items-center gap-1.5"><TargetIcon className="size-3.5 shrink-0 text-primary" /><strong className="shrink-0">Goal · {status}</strong><span className="truncate text-muted-foreground" title={goal.objective}>{goal.objective}</span></span>
    {goal.status === "active" && !goal.waitingReason && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={() => pause()}>{t("goal.pause")}</button>}
    {(goal.status === "paused" || goal.status === "blocked" || Boolean(goal.waitingReason)) && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={() => resume()}>{t("goal.resume")}</button>}
    <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={() => clear()}>{t("goal.clear")}</button>
  </div>;
};

const ComposerAction: FC<{ mentionOpen: boolean; onToggleMention: () => void }> = ({ mentionOpen, onToggleMention }) => {
  const { t } = useLocale();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const showSend = useAuiState((state) => !state.thread.isRunning || (state.thread.capabilities.queue && state.composer.canSend));
  const compacting = useConversationStore((state) => Boolean(state.currentSessionId && state.compactionStatuses[state.currentSessionId]));
  const editing = useConversationStore((state) => Boolean(state.editingQueueItem));
  const sendLabel = t(editing ? "chat.queueSave" : isRunning ? "chat.queueSend" : "chat.sendMessage");
  return (
    <div className="aui-composer-action-wrapper relative flex min-h-7 items-center justify-between gap-2 px-2 pb-2 mt-1">
      <div className="q-composer-actions-leading flex min-w-0 items-center gap-1">
        <ComposerToolsPopover open={mentionOpen} onToggle={onToggleMention} />
        <RunOptionsPopover />
      </div>
      <div className="q-composer-actions-trailing flex min-w-0 flex-1 items-center justify-end gap-1">
        <AssistantContext />
        <ModelPicker />
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton tooltip={t("chat.voiceInput")} side="bottom" type="button" variant="ghost" size="icon" className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full" aria-label={t("chat.startVoiceInput")}>
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton tooltip={t("chat.stopDictation")} side="bottom" type="button" variant="ghost" size="icon" className="aui-composer-stop-dictation text-destructive size-7 rounded-full" aria-label={t("chat.stopVoiceInput")}>
                <SquareIcon className="aui-composer-stop-dictation-icon size-3.5 animate-pulse fill-current" />
              </TooltipIconButton>
            </ComposerPrimitive.StopDictation>
          </AuiIf>
        </AuiIf>
        <div className="q-composer-submit-control relative size-7 shrink-0">
          <span className="q-composer-submit-glyph pointer-events-none absolute inset-0 z-10 flex items-center justify-center">
            <ComposerActionGlyph stopped={!showSend} />
          </span>
          <AuiIf condition={(s) => !s.thread.isRunning || (s.thread.capabilities.queue && s.composer.canSend)}>
            <ComposerPrimitive.Send asChild>
              <Button
                type="button"
                variant="default"
                size="icon"
                className="aui-composer-send absolute inset-0"
                aria-label={sendLabel}
                title={sendLabel}
                disabled={compacting}
              >
                <span className="sr-only">{sendLabel}</span>
              </Button>
            </ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={(s) => s.thread.isRunning && !(s.thread.capabilities.queue && s.composer.canSend)}>
            <ComposerPrimitive.Cancel asChild>
              <Button type="button" variant="default" size="icon" className="aui-composer-cancel absolute inset-0" aria-label={t("chat.stopGenerating")} title={t("chat.stopGenerating")}>
                <span className="sr-only">{t("chat.stopGenerating")}</span>
              </Button>
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </div>
      </div>
    </div>
  );
};

const retryUserMessage = (messageId: string, owner: ReturnType<typeof useConversationStoreApi>) => {
  const state = owner.getState();
  const source = state.messages.find((message) => message.id === messageId && message.role === "user");
  if (source) state.runAgent(source.content, source.id, source.attachments, undefined, Boolean(source.goalId), undefined, source.quote);
};

const AssistantMessage: FC<{ userMessageId?: string; showLatestExtras: boolean; betweenContent?: ReactNode }> = memo(({ userMessageId, showLatestExtras, betweenContent }) => {
  const owner = useConversationStoreApi();
  const { t } = useLocale();
  const messageId = useAuiState((state) => state.message.id);
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const answerError = useConversationStore((state) => {
    const error = state.chatRunError;
    if (!error || error.sessionId !== state.currentSessionId) return undefined;
    return messageId === chatRunErrorMessageId(error.userMessageId) ? error : undefined;
  });
  const runId = useConversationStore((state) => messageId === "streaming" ? state.activeRunId : messageById(state.messages, messageId)?.runId);
  const runIds = useMemo(() => runId ? [runId] : [], [runId]);
  return (
      <MessagePair
        userMessage=""
        words={[]}
        visibleWords={0}
        streaming={false}
        showUser={Boolean(userMessageId)}
        className="aui-message-pair mx-auto w-full q-thread-content gap-5"
        userContent={userMessageId ? (
          <ThreadPrimitive.Unstable_MessageById
            messageId={userMessageId}
            components={{ Message: UserMessageContent }}
          />
        ) : undefined}
        userContentIsSurface={Boolean(userMessageId)}
        userActions={userMessageId ? (
          <ThreadPrimitive.Unstable_MessageById
            messageId={userMessageId}
            components={{ Message: UserMessageActions }}
          />
        ) : undefined}
        betweenContent={betweenContent}
        assistantContent={
          <AssistantMessageLayout actions={answerError || messageRunning ? undefined : <AssistantMessageActions />}>
            {answerError ? <div className="flex flex-col gap-1 text-sm leading-relaxed" role="alert">
              <p className="font-medium text-foreground">{t("chat.runFailed")}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">{answerError.detail || t("chat.runFailedDetail")}</p>
              <button type="button" className="mt-1 flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => retryUserMessage(answerError.userMessageId, owner)}>
                <RefreshCwIcon className="size-3.5" />{t("chat.retryMessage")}
              </button>
            </div> : <AssistantParts />}
            {!answerError && <>
              <GeneratedMediaArtifacts runIds={runIds} />
              <MessageSourcesView />
              <AssistantMemoryChips visible={showLatestExtras} />
            </>}
          </AssistantMessageLayout>
        }
      />
  );
});
AssistantMessage.displayName = "AssistantMessage";
