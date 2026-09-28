import { ComposerAttachments, ComposerAddAttachment } from "./elements/attachment.aui";
import { File } from "./elements/file";
import { UserImageThumbnail } from "./elements/user-image-thumbnail";
import { ComposerToolChip, ComposerToolsPopover, type ComposerTool } from "./composer-tools";
import { ComposerTriggers } from "./composer-triggers";
import { ComposerEditorBridge, type InsertComposerTool, type ToggleComposerMention } from "./composer-editor-bridge";
import { ComposerActionGlyph } from "./composer-action-glyph";
import { LongPasteAttachmentPlugin } from "./long-paste-attachment";
import { AssistantParts } from "./assistant-parts";
import { MessagePair } from "./elements/message-pair";
import { DaySeparatorMarker } from "./elements/day-separator";
import { ErrorState } from "./elements/error-state";
import { pairMessageIds } from "./message-pairing";
import { messageDaySeparators } from "./message-day-separators";
import { MessageSourcesView } from "./message-sources-view";
import { AssistantContext, AssistantMemoryChips } from "./assistant-context";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { ModelPicker } from "./model-picker";
import { RunOptionsPopover } from "./run-options-popover";
import { EllipsisDots, ShimmerLabel } from "./elements/surfaces";
import { ConversationMapAui } from "./elements/conversation-map.aui";
import { ComposerLoadingSkeleton, ConversationLoadingSkeleton } from "./loading-skeleton";
import "./thread-viewport.css";
import "./composer-queue.css";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { pickNativeAttachmentFiles, useNativeFileDrop } from "../../lib/native-file-drop";
import { hasTauriBridge } from "../../store";
import { fileFromDataUrl, getQoneMessageQueue } from "../../lib/qone-message-queue";
import { createNativeAttachmentFile } from "../../lib/native-attachment-file";
import { ComposerQueueEnterPlugin } from "./composer-queue-enter";
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  QueueItemPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
  type QueueItemState,
} from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import {
  CheckIcon,
  ChevronDownIcon,
  CornerDownRightIcon,
  CopyIcon,
  MicIcon,
  RefreshCwIcon,
  SquareIcon,
  FolderPlusIcon,
  Loader2Icon,
  PencilIcon,
  TargetIcon,
  Trash2Icon,
} from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type FC, type RefObject } from "react";

export const Thread: FC<{ children?: ReactNode }> = ({ children }) => {
  const { locale, t } = useLocale();
  const sessions = useStore((state) => state.sessions);
  const workspaces = useStore((state) => state.workspaces);
  const currentSessionId = useStore((state) => state.currentSessionId);
  const currentWorkspaceId = useStore((state) => state.currentWorkspaceId);
  const workspaceLoadingId = useStore((state) => state.workspaceLoadingId);
  const draftWorkspaceId = useStore((state) => state.draftWorkspaceId);
  const creatingSession = useStore((state) => state.creatingSession);
  const sessionsLoaded = useStore((state) => state.sessionsLoaded);
  const workspacesLoaded = useStore((state) => state.workspacesLoaded);
  const messagesLoadingSessionId = useStore((state) => state.messagesLoadingSessionId);
  const threadMessages = useAuiState((state) => state.thread.messages);
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const nextMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const timer = setTimeout(() => setToday(new Date()), nextMidnight.getTime() - Date.now());
    return () => clearTimeout(timer);
  }, [today]);
  const pairedUserIdByAssistant = useMemo(() => pairMessageIds(threadMessages), [threadMessages]);
  const pairedUserIds = useMemo(() => new Set(pairedUserIdByAssistant.values()), [pairedUserIdByAssistant]);
  const latestAssistantId = useMemo(
    () => [...threadMessages].reverse().find((message) => message.role === "assistant")?.id,
    [threadMessages],
  );
  const daySeparators = useMemo(() => messageDaySeparators(threadMessages, pairedUserIdByAssistant, today), [threadMessages, pairedUserIdByAssistant, today]);
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }), [locale]);
  const canChat = (() => {
    const session = sessions.find((item) => item.id === currentSessionId);
    return Boolean(
      (session?.workspaceId && workspaces.some((workspace) => workspace.id === session.workspaceId)) ||
      (draftWorkspaceId && workspaces.some((workspace) => workspace.id === draftWorkspaceId)),
    );
  })();
  const conversationLoading = !sessionsLoaded || !workspacesLoaded || Boolean(
    currentWorkspaceId && workspaceLoadingId === currentWorkspaceId,
  ) || Boolean(
    currentSessionId && messagesLoadingSessionId === currentSessionId,
  );
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root bg-background text-foreground flex h-full flex-col items-stretch px-4 [--q-chat-bg:var(--background)]"
      style={{
        ["--composer-bg" as string]: "var(--color-muted)",
        ["--composer-radius" as string]: "var(--radius-thread)",
        ["--composer-padding" as string]: "8px",
      }}
    >
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
        <ThreadPrimitive.Viewport turnAnchor="top" autoScroll className="aui-viewport flex min-h-0 grow flex-col gap-7 overflow-y-auto">
          <ConversationMapAui />
          <div className="q-message-list flex w-full min-w-0 flex-col gap-7 pt-6">
            <ThreadPrimitive.Messages>
              {({ message }) => {
                if (message.role === "user" && pairedUserIds.has(message.id)) return null;
                const date = daySeparators.get(message.id);
                return (
                  <div
                    className="q-message-block flex w-full flex-col gap-5"
                    data-message-block
                    data-turn-id={message.role === "user" ? message.id : pairedUserIdByAssistant.get(message.id)}
                    data-static-turn={message.id !== latestAssistantId && message.id !== threadMessages.at(-1)?.id ? "" : undefined}
                  >
                    {message.role === "user"
                      ? <UserMessage messageId={message.id} />
                      : <AssistantMessage
                        userMessageId={pairedUserIdByAssistant.get(message.id)}
                        showLatestExtras={message.id === latestAssistantId}
                      />}
                    {date && <DaySeparatorMarker day={dayFormatter.format(date)} className="mx-auto q-thread-content" />}
                  </div>
                );
              }}
            </ThreadPrimitive.Messages>
          </div>
          <ChatRunErrorView />
          <div className="mx-auto w-full q-thread-content empty:hidden">{children}</div>

          <ThreadPrimitive.ViewportFooter className="q-chat-footer sticky bottom-0 z-20 mt-auto flex w-full flex-col overflow-visible bg-transparent pb-2">
            <ThreadScrollToBottom />
            <div className="relative z-1 mx-auto w-full q-composer-content">
              {canChat ? <Composer placeholder={t("chat.placeholder")} /> : <ProjectImportPrompt compact />}
            </div>
          </ThreadPrimitive.ViewportFooter>
        </ThreadPrimitive.Viewport>
      </AuiIf>
      </>}
    </ThreadPrimitive.Root>
  );
};

const ProjectImportPrompt: FC<{ compact?: boolean }> = ({ compact = false }) => {
  const { t } = useLocale();
  const chooseWorkspace = useStore((state) => state.chooseWorkspace);
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
  "aui-composer-input [&_.aui-lexical-placeholder]:text-muted-foreground/60 relative max-h-48 min-h-9 w-full resize-none bg-transparent px-2.5 py-1 text-sm leading-6 outline-none [&_.aui-lexical-input]:min-h-lh [&_.aui-lexical-input]:outline-none [&_.aui-lexical-placeholder]:pointer-events-none [&_.aui-lexical-placeholder]:absolute [&_.aui-lexical-placeholder]:top-0 [&_.aui-lexical-placeholder]:right-0 [&_.aui-lexical-placeholder]:left-0 [&_.aui-lexical-placeholder]:truncate [&_.aui-lexical-placeholder]:px-2.5 [&_.aui-lexical-placeholder]:py-1";

const QueueIcon: FC = () => (
  <svg className="size-4 shrink-0 text-muted-foreground/70" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    <path d="M3 3v8c0 2.2 1.3 3.5 3.5 3.5H16m-3-3 3 3-3 3M7.5 5h6.5M7.5 9.5h4" />
  </svg>
);

const QueueItemRow: FC<{ queueItem: QueueItemState; steering: boolean; onEdit: () => void }> = ({ queueItem, steering, onEdit }) => {
  const { t } = useLocale();
  return (
    <div role="listitem" className="q-composer-queue-item flex min-h-12 min-w-0 items-center gap-2 px-3 py-1 text-sm transition-colors hover:bg-foreground/[0.03]">
      <QueueIcon />
      <QueueItemPrimitive.Text className="min-w-0 flex-1 truncate text-foreground/85" title={queueItem.prompt} />
      {steering ? <span className="shrink-0 text-muted-foreground">{t("chat.steerPending")}</span> : <div className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
        <QueueItemPrimitive.Steer asChild>
          <Button variant="ghost" size="icon-sm" title={t("chat.queueSteer")} aria-label={t("chat.queueSteer")} className="h-7 w-auto gap-1 rounded-md px-1.5 text-xs text-muted-foreground hover:text-foreground">
            <CornerDownRightIcon className="size-3.5" aria-hidden />{t("chat.queueSteer")}
          </Button>
        </QueueItemPrimitive.Steer>
        <QueueItemPrimitive.Remove asChild>
          <TooltipIconButton tooltip={t("chat.queueRemove")} className="size-7 rounded-md text-muted-foreground hover:text-foreground">
            <Trash2Icon className="size-3.5" aria-hidden />
          </TooltipIconButton>
        </QueueItemPrimitive.Remove>
        <TooltipIconButton tooltip={t("chat.queueEdit")} className="size-7 rounded-md text-muted-foreground hover:text-foreground" onClick={onEdit}>
          <PencilIcon className="size-3.5" aria-hidden />
        </TooltipIconButton>
      </div>}
    </div>
  );
};

const Composer: FC<{ placeholder: string }> = ({ placeholder }) => {
  const aui = useAui();
  const { t } = useLocale();
  const sessionId = useStore((state) => state.currentSessionId);
  const compactSession = useStore((state) => state.compactSession);
  const compactionStatus = useStore((state) => state.compactionStatus);
  const editingQueueItem = useStore((state) => state.editingQueueItem);
  const insertToolRef = useRef<InsertComposerTool | null>(null);
  const toggleMentionRef = useRef<ToggleComposerMention | null>(null);
  const closeMentionRef = useRef<(() => void) | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
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
  const onToolSelect = useCallback((tool: ComposerTool) => {
    if (tool.id === "attachment") {
      if (hasTauriBridge()) void pickNativeAttachmentFiles().then(onNativeFiles).catch((error) => {
        useStore.setState({ lastError: error instanceof Error ? error.message : String(error) });
      });
      else shellRef.current?.querySelector<HTMLButtonElement>(".aui-composer-add-attachment")?.click();
    }
    else if (tool.id === "compact") compactSession();
    else insertToolRef.current?.({ id: tool.id, label: tool.label });
  }, [compactSession, onNativeFiles]);
  const onMentionStateChange = useCallback((open: boolean, close: () => void) => {
    closeMentionRef.current = close;
    setMentionOpen(open);
  }, []);
  const onMentionToggleReady = useCallback((toggle: ToggleComposerMention | null) => { toggleMentionRef.current = toggle; }, []);
  const toggleMention = useCallback(() => {
    if (mentionOpen) closeMentionRef.current?.();
    else toggleMentionRef.current?.();
  }, [mentionOpen]);

  return (
    <>
    <GoalStatusBar />
    {compactionStatus && compactionStatus.sessionId === sessionId && (
      <div role="status" aria-live="polite" className="q-composer-content mx-auto mb-2 text-xs text-muted-foreground">
        {t(compactionStatus.phase === "running" ? "composer.compacting" : "composer.compacted")}
      </div>
    )}
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <div className="q-composer-rail">
        <div className="q-composer-queue" role="list" aria-label={t("chat.queueLabel")}>
          <ComposerPrimitive.Queue>
          {({ queueItem }) => {
            const activeQueue = sessionId ? getQoneMessageQueue(sessionId) : undefined;
            const persistentId = activeQueue?.getPersistentId(queueItem.id);
            if (persistentId && editingQueueItem?.id === persistentId) return null;
            // The local steer lane changes the moment steering starts, before
            // the runtime snapshot catches up.
            const steering = Boolean(activeQueue?.adapter.steerItems.some((item) => item.id === queueItem.id));
            return <QueueItemRow queueItem={queueItem} steering={steering} onEdit={() => {
              if (!activeQueue || !persistentId) return;
              const item = activeQueue.getItem(persistentId);
              if (!item) return;
              // Loading the queued message replaces the composer; never discard an unsent draft.
              if (!aui.composer().getState().isEmpty) {
                useStore.setState({ lastError: t("chat.queueEditDraftBlocked") });
                return;
              }
              if (!activeQueue.beginEdit(queueItem.id)) return;
              useStore.setState({ editingQueueItem: item });
              aui.composer().setText(item.text);
              void aui.composer().clearAttachments().then(async () => {
                for (const attachment of item.attachments ?? []) {
                  if (attachment.localPath) {
                    await aui.composer().addAttachment(createNativeAttachmentFile(attachment.name, attachment.mimeType, attachment.localPath, 0));
                  } else {
                    await aui.composer().addAttachment({
                      id: crypto.randomUUID(),
                      type: attachment.type,
                      name: attachment.name,
                      contentType: attachment.mimeType,
                      content: attachment.type === "image"
                        ? [{ type: "image", image: attachment.data, filename: attachment.name }]
                        : [{ type: "file", data: attachment.data, filename: attachment.name, mimeType: attachment.mimeType }],
                    });
                  }
                }
              }).catch(() => undefined);
            }} />;
          }}
          </ComposerPrimitive.Queue>
        </div>
      </div>
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          ref={shellRef}
          data-slot="aui_composer-shell"
          className="relative z-10 border-foreground/10 data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-1 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          {editingQueueItem && (
            <div className="flex items-center justify-between px-2.5 py-1 text-xs text-muted-foreground" role="status">
              <span>正在编辑待发送消息</span>
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-foreground/10" onClick={() => { if (sessionId) getQoneMessageQueue(sessionId)?.cancelEdit(); useStore.setState({ editingQueueItem: undefined }); void aui.composer().reset(); }}>取消</button>
            </div>
          )}
          <ComposerAttachments />
          <ComposerAddAttachment hidden />
          <LexicalComposerInput autoFocus submitMode="none" placeholder={placeholder} className={composerInputClass} directiveChip={ComposerToolChip}>
            <ComposerEditorBridge onReady={onEditorReady} onMentionToggleReady={onMentionToggleReady} />
            <LongPasteAttachmentPlugin />
            <ComposerQueueEnterPlugin menuOpen={mentionOpen} />
          </LexicalComposerInput>
          <ComposerTriggers onToolSelect={onToolSelect} onMentionStateChange={onMentionStateChange} />
          <ComposerAction mentionOpen={mentionOpen} onToggleMention={toggleMention} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </ComposerPrimitive.Root>
    </>
  );
};

const GoalStatusBar: FC = () => {
  const goal = useStore((state) => state.goal);
  const pause = useStore((state) => state.pauseGoal);
  const resume = useStore((state) => state.resumeGoal);
  const clear = useStore((state) => state.clearGoal);
  if (!goal) return null;
  const status = goal.waitingReason ? "等待外部事件" : goal.status === "active" ? "执行中" : goal.status === "paused" ? "已暂停" : goal.status === "blocked" ? "已阻塞" : "已完成";
  return <div className="mx-auto mb-2 flex w-full q-composer-content items-center gap-2 rounded-xl border border-foreground/10 bg-muted/30 px-3 py-2 text-xs" role="status">
    <span className="flex min-w-0 flex-1 items-center gap-1.5"><TargetIcon className="size-3.5 shrink-0 text-primary" /><strong className="shrink-0">Goal · {status}</strong><span className="truncate text-muted-foreground" title={goal.objective}>{goal.objective}</span></span>
    {goal.status === "active" && !goal.waitingReason && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={pause}>暂停</button>}
    {(goal.status === "paused" || goal.status === "blocked" || Boolean(goal.waitingReason)) && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={resume}>恢复</button>}
    <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={clear}>清除</button>
  </div>;
};

const ComposerAction: FC<{ mentionOpen: boolean; onToggleMention: () => void }> = ({ mentionOpen, onToggleMention }) => {
  const { t } = useLocale();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const showSend = useAuiState((state) => !state.thread.isRunning || (state.thread.capabilities.queue && state.composer.canSend));
  const sendLabel = t(isRunning ? "chat.queueSend" : "chat.sendMessage");
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1">
        <ComposerToolsPopover open={mentionOpen} onToggle={onToggleMention} />
        <RunOptionsPopover />
      </div>
      <div className="flex items-center gap-1.5">
        <ModelPicker />
        <AuiIf condition={(s) => s.thread.capabilities.dictation}>
          <AuiIf condition={(s) => s.composer.dictation == null}>
            <ComposerPrimitive.Dictate asChild>
              <TooltipIconButton tooltip="Voice input" side="bottom" type="button" variant="ghost" size="icon" className="aui-composer-dictate text-muted-foreground hover:text-foreground size-7 rounded-full" aria-label="Start voice input">
                <MicIcon className="aui-composer-dictate-icon size-4" />
              </TooltipIconButton>
            </ComposerPrimitive.Dictate>
          </AuiIf>
          <AuiIf condition={(s) => s.composer.dictation != null}>
            <ComposerPrimitive.StopDictation asChild>
              <TooltipIconButton tooltip="Stop dictation" side="bottom" type="button" variant="ghost" size="icon" className="aui-composer-stop-dictation text-destructive size-7 rounded-full" aria-label="Stop voice input">
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

const ThreadScrollToBottom: FC = () => {
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip="Scroll to bottom"
        className="bg-background absolute -top-10 z-10 self-center rounded-full border p-2 disabled:invisible dark:border-white/15 dark:bg-[#2a2a2a]"
      >
        <ChevronDownIcon className="size-5" />
      </TooltipIconButton>
    </ThreadPrimitive.ScrollToBottom>
  );
};

const assistantActionClassName =
  "flex size-7 items-center justify-center rounded-md bg-transparent! shadow-none! text-muted-foreground transition-colors hover:bg-transparent! hover:shadow-none! hover:text-foreground";

const retryUserMessage = (messageId: string) => {
  const state = useStore.getState();
  const source = state.messages.find((message) => message.id === messageId && message.role === "user");
  if (source) state.runAgent(source.content, source.id, source.attachments, undefined, Boolean(source.goalId));
};

const UserMessageText: FC<{ paired?: boolean }> = ({ paired = false }) => {
  const hasText = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "text" && part.text.length > 0,
  ));
  if (!hasText) return null;

  return (
    <div className={cn("q-user-message-bubble w-fit min-w-0 break-words text-start", paired ? "q-user-message-bubble-paired max-w-full" : "max-w-[70%]")}>
      <MessagePrimitive.Parts>
        {({ part }) => part.type === "text" ? <span className="whitespace-pre-wrap">{part.text}</span> : null}
      </MessagePrimitive.Parts>
    </div>
  );
};

const UserMessage: FC<{ messageId: string }> = ({ messageId }) => {
  const { t } = useLocale();
  return (
    <MessagePrimitive.Root className="q-message-root q-message-user relative mx-auto flex w-full q-thread-content flex-col items-end gap-0.5">
      <PairUserAttachments />
      <UserMessageText />

      <div className="q-message-action-slot flex items-center">
        <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="flex items-center gap-0.5">
          <ActionBarPrimitive.Copy asChild>
            <TooltipIconButton tooltip={t("chat.copyMessage")} side="top" className={assistantActionClassName}>
              <AuiIf condition={(s) => s.message.isCopied}>
                <CheckIcon className="size-4" />
              </AuiIf>
              <AuiIf condition={(s) => !s.message.isCopied}>
                <CopyIcon className="size-4" />
              </AuiIf>
            </TooltipIconButton>
          </ActionBarPrimitive.Copy>
          <TooltipIconButton tooltip={t("chat.retryMessage")} side="top" className={assistantActionClassName} onClick={() => retryUserMessage(messageId)}>
            <RefreshCwIcon className="size-4" />
          </TooltipIconButton>
        </ActionBarPrimitive.Root>
      </div>
    </MessagePrimitive.Root>
  );
};

const PairUserContent: FC = () => {
  return (
    <MessagePrimitive.Root className="q-message-root q-message-user relative flex w-fit max-w-[70%] flex-col items-end gap-0.5 self-end">
      <UserMessageText paired />
    </MessagePrimitive.Root>
  );
};

const PairUserAttachments: FC = () => {
  const hasAttachments = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "file" || part.type === "image",
  ));
  if (!hasAttachments) return null;

  return (
    <div className="q-message-user-attachments flex w-fit max-w-[70%] min-w-0 flex-nowrap items-end gap-2 self-end overflow-x-auto overscroll-x-contain pb-1">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === "file") return <div className="shrink-0"><File {...part} /></div>;
          if (part.type === "image") return <UserImageThumbnail {...part} />;
          return null;
        }}
      </MessagePrimitive.Parts>
    </div>
  );
};

const PairUserActions: FC = () => {
  const { t } = useLocale();
  const messageId = useAuiState((state) => state.message.id);

  return (
    <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="flex items-center gap-0.5">
      <ActionBarPrimitive.Copy asChild>
        <TooltipIconButton tooltip={t("chat.copyMessage")} side="top" className={assistantActionClassName}>
          <AuiIf condition={(s) => s.message.isCopied}>
            <CheckIcon className="size-4" />
          </AuiIf>
          <AuiIf condition={(s) => !s.message.isCopied}>
            <CopyIcon className="size-4" />
          </AuiIf>
        </TooltipIconButton>
      </ActionBarPrimitive.Copy>
      <TooltipIconButton tooltip={t("chat.retryMessage")} side="top" className={assistantActionClassName} onClick={() => retryUserMessage(messageId)}>
        <RefreshCwIcon className="size-4" />
      </TooltipIconButton>
    </ActionBarPrimitive.Root>
  );
};

const AssistantMessage: FC<{ userMessageId?: string; showLatestExtras: boolean }> = ({ userMessageId, showLatestExtras }) => {
  const { t } = useLocale();
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
            components={{ Message: PairUserContent }}
          />
        ) : undefined}
        userContentIsSurface={Boolean(userMessageId)}
        userAttachmentContent={userMessageId ? (
          <ThreadPrimitive.Unstable_MessageById
            messageId={userMessageId}
            components={{ Message: PairUserAttachments }}
          />
        ) : undefined}
        userActions={userMessageId ? (
          <ThreadPrimitive.Unstable_MessageById
            messageId={userMessageId}
            components={{ Message: PairUserActions }}
          />
        ) : undefined}
        assistantContent={
          <MessagePrimitive.Root className="q-message-root q-message-assistant relative flex w-full flex-col">
            <AssistantParts hideSubagentCalls showSubagentCapsule />
            <MessageSourcesView />
            <AssistantMemoryChips visible={showLatestExtras} />
            <AgentPreparation />
          </MessagePrimitive.Root>
        }
        actions={
          <div className="flex items-center gap-1">
            <ActionBarPrimitive.Root hideWhenRunning autohide="never" className="flex items-center gap-0.5">
            <ActionBarPrimitive.Copy asChild>
              <TooltipIconButton tooltip={t("chat.copyMessage")} side="top" className={assistantActionClassName}>
                <AuiIf condition={(s) => s.message.isCopied}>
                  <CheckIcon className="size-4" />
                </AuiIf>
                <AuiIf condition={(s) => !s.message.isCopied}>
                  <CopyIcon className="size-4" />
                </AuiIf>
              </TooltipIconButton>
            </ActionBarPrimitive.Copy>
            <ActionBarPrimitive.Reload asChild>
              <TooltipIconButton tooltip={t("chat.retryMessage")} side="top" className={assistantActionClassName}>
                <RefreshCwIcon className="size-4" />
              </TooltipIconButton>
            </ActionBarPrimitive.Reload>
            </ActionBarPrimitive.Root>
            <AuiIf condition={(s) => s.message.status?.type === "complete" && s.message.content.length > 0}>
              <AssistantContext visible={showLatestExtras} />
            </AuiIf>
          </div>
        }
      />
  );
};

const AgentPreparation: FC = () => {
  const { t } = useLocale();
  const messageRunning = useAuiState((state) => state.message.status?.type === "running");
  const activeMessageSequence = useStore((state) => state.activeMessageSequence);
  const streaming = useStore((state) => state.streaming);
  const streamingParts = useStore((state) => state.streamingParts);
  const toolCalls = useStore((state) => state.toolCalls);
  const toolCallsById = useMemo(
    () => new Map(toolCalls.map((call) => [call.toolCallId, call] as const)),
    [toolCalls],
  );
  const latestMessageSequence = streamingParts.at(-1)?.messageSequence;
  const phaseKey = String(activeMessageSequence ?? latestMessageSequence ?? "run-start");
  const currentParts = useMemo(
    () => (activeMessageSequence ?? latestMessageSequence) === undefined
      ? []
      : streamingParts.filter((part) => part.messageSequence === (activeMessageSequence ?? latestMessageSequence)),
    [activeMessageSequence, latestMessageSequence, streamingParts],
  );
  const hasCurrentText = Boolean(streaming.trim()) || (activeMessageSequence !== undefined && currentParts.some(
    (part) => part.type === "text" && part.text.trim().length > 0,
  ));
  const hasUnfinishedTool = currentParts.some((part) => {
    if (part.type !== "tool-call") return false;
    const call = toolCallsById.get(part.toolCallId);
    return call?.status === "running" || call?.status === "waiting"
      || (!call && part.result === undefined && !part.isError);
  });
  const parts = useAuiState((state) => state.message.parts);
  const tailPart = parts.at(-1);
  const tailIsToolRegion = tailPart?.type === "tool-call"
    && (tailPart.toolName !== "present" || Boolean(tailPart.isError));
  // The run can be active before Pi emits message.started. Keep this fallback
  // independent of activeMessageSequence so the first visible state is not a
  // blank assistant bubble.
  const candidate = messageRunning && !hasCurrentText && !hasUnfinishedTool && !tailIsToolRegion;
  const [visiblePhase, setVisiblePhase] = useState<string>();

  useEffect(() => {
    if (!candidate) {
      setVisiblePhase(undefined);
      return undefined;
    }
    const timer = setTimeout(() => setVisiblePhase(phaseKey), 400);
    return () => clearTimeout(timer);
  }, [candidate, phaseKey]);

  if (!candidate || visiblePhase !== phaseKey) return null;
  return (
    <div className="text-foreground/55 flex items-center py-1 text-sm" role="status" aria-live="polite">
      <ShimmerLabel active className="relative inline-block leading-none">
        {t("chat.connecting")}
      </ShimmerLabel>
      <EllipsisDots />
    </div>
  );
};

const ChatRunErrorView: FC = () => {
  const { t } = useLocale();
  const error = useStore((state) => state.chatRunError);
  const sessionId = useStore((state) => state.currentSessionId);
  const userMessage = useStore((state) => state.messages.find(
    (message) => message.id === error?.userMessageId && message.role === "user",
  ));
  if (!error || error.sessionId !== sessionId || !userMessage) return null;

  return (
    <div className="mx-auto w-full q-thread-content">
      <ErrorState
        className="max-w-none"
        title={t("chat.runFailed")}
        detail={error.detail || t("chat.runFailedDetail")}
        retrying={false}
        retryLabel={t("chat.retryMessage")}
        onRetry={() => retryUserMessage(userMessage.id)}
      />
    </div>
  );
};
