import { ComposerAttachments, ComposerAddAttachment } from "./elements/attachment.aui";
import { File } from "./elements/file";
import { UserImageThumbnail } from "./elements/user-image-thumbnail";
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
import { assistantWaitingPhase } from "./assistant-waiting-phase";
import { GeneratedMediaArtifacts } from "./generated-media-artifacts";
import { MessagePair } from "./elements/message-pair";
import { DaySeparatorMarker } from "./elements/day-separator";
import { chatRunErrorMessageId } from "../../lib/chat-run-error-message";
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
import { ContextCompactionMarker } from "./context-compaction-marker";
import { ComposerLoadingSkeleton, ConversationLoadingSkeleton } from "./loading-skeleton";
import { ThreadScrollFollower } from "./thread-scroll-follower";
import "./thread-viewport.css";
import "./composer-queue.css";
import { useStore } from "../../store";
import { getThreadScrollState, pruneThreadScrollStates } from "../../lib/thread-scroll-state";
import { useLocale } from "../../localization";
import { pickNativeAttachmentFiles, pickNativeAttachmentFolder, useNativeFileDrop } from "../../lib/native-file-drop";
import { hasTauriBridge } from "../../store";
import { fileFromDataUrl, getQoneMessageQueue } from "../../lib/qone-message-queue";
import { createNativeAttachmentFile } from "../../lib/native-attachment-file";
import { ComposerQueueEnterPlugin } from "./composer-queue-enter";
import { ComposerHistoryPlugin } from "./composer-history";
import { DropdownMenu } from "radix-ui";
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
  const draftWorkspaceId = useStore((state) => state.draftWorkspaceId);
  const creatingSession = useStore((state) => state.creatingSession);
  const sessionsLoaded = useStore((state) => state.sessionsLoaded);
  const workspacesLoaded = useStore((state) => state.workspacesLoaded);
  const messagesLoadingSessionId = useStore((state) => state.messagesLoadingSessionId);
  useEffect(() => {
    if (sessionsLoaded) pruneThreadScrollStates(sessions.map((session) => session.id));
  }, [sessions, sessionsLoaded]);
  const threadMessages = useAuiState((state) => state.thread.messages);
  const chatRunError = useStore((state) => state.chatRunError);
  const compactions = useStore((state) => state.compactions);
  const compactionStatus = useStore((state) => state.currentSessionId ? state.compactionStatuses[state.currentSessionId] : undefined);
  const autoCompactionStatus = useStore((state) => state.currentSessionId ? state.autoCompactionStatuses[state.currentSessionId] : undefined);
  const [today, setToday] = useState(() => new Date());
  useEffect(() => {
    const nextMidnight = new Date(today.getFullYear(), today.getMonth(), today.getDate() + 1);
    const timer = setTimeout(() => setToday(new Date()), nextMidnight.getTime() - Date.now());
    return () => clearTimeout(timer);
  }, [today]);
  const pairedUserIdByAssistant = useMemo(() => pairMessageIds(threadMessages), [threadMessages]);
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
  const daySeparators = useMemo(() => messageDaySeparators(threadMessages, pairedUserIdByAssistant, today), [threadMessages, pairedUserIdByAssistant, today]);
  const dayFormatter = useMemo(() => new Intl.DateTimeFormat(locale, { year: "numeric", month: "long", day: "numeric" }), [locale]);
  const canChat = (() => {
    const session = sessions.find((item) => item.id === currentSessionId);
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
  return (
    <ThreadPrimitive.Root
      className="aui-root aui-thread-root relative bg-background text-foreground flex h-full flex-col items-stretch px-4 [--q-chat-bg:var(--background)]"
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
        <ThreadPrimitive.Viewport
          key={currentSessionId}
          turnAnchor="top"
          scrollRestoration={getThreadScrollState(currentSessionId)}
          scrollToBottomOnInitialize={false}
          scrollToBottomOnRunStart={false}
          scrollToBottomOnThreadSwitch={false}
          className="aui-viewport flex min-h-0 grow flex-col gap-7 overflow-y-auto"
        >
          <ConversationMapAui />
          <ThreadScrollFollower contentRef={messageListRef} />
          <div ref={messageListRef} className="q-message-list relative flex w-full min-w-0 flex-col gap-5 pt-4">
            <div data-conversation-rail-content aria-hidden="true" className="pointer-events-none invisible absolute inset-x-0 top-0 mx-auto h-0 w-full q-thread-content" />
            <ThreadPrimitive.Messages>
              {({ message }) => {
                if (message.role === "user" && pairedUserIds.has(message.id)) return null;
                const date = daySeparators.get(message.id);
                return (
                  <div
                    className="q-message-block flex w-full flex-col gap-4"
                    data-message-block
                    data-turn-id={message.role === "user" ? message.id : pairedUserIdByAssistant.get(message.id)}
                    data-static-turn={message.id !== latestAssistantId && message.id !== threadMessages.at(-1)?.id ? "" : undefined}
                  >
                    {message.role === "user"
                      ? <UserMessage messageId={message.id} />
                      : <AssistantMessage
                        userMessageId={pairedUserIdByAssistant.get(message.id)}
                        showLatestExtras={message.id === latestAssistantId}
                        betweenContent={compactionMarkersByMessage.between.get(message.id)?.map((marker) => (
                          <ContextCompactionMarker key={marker.id} status={marker.status} source={marker.source} startedAt={marker.startedAt} />
                        ))}
                      />}
                    {date && <DaySeparatorMarker day={dayFormatter.format(date)} className="mx-auto q-thread-content" />}
                    {compactionMarkersByMessage.after.get(message.id)?.map((marker) => (
                      <ContextCompactionMarker key={marker.id} status={marker.status} source={marker.source} startedAt={marker.startedAt} />
                    ))}
                  </div>
                );
              }}
            </ThreadPrimitive.Messages>
          </div>
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
const composerNodes = [ComposerLinkNode, ComposerUnlinkedNode] as const;

const CodexQueueIcon: FC<{ className?: string }> = ({ className = "size-4 shrink-0 text-muted-foreground/70" }) => (
  <svg className={className} width="16" height="16" viewBox="0 0 20 20" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M2.66797 11V3.33301C2.66797 2.96574 2.96574 2.66797 3.33301 2.66797C3.70028 2.66797 3.99805 2.96574 3.99805 3.33301V11C3.99805 11.7109 3.99894 12.2044 4.03027 12.5879C4.06098 12.9634 4.11776 13.175 4.19824 13.333L4.26856 13.459C4.44487 13.7465 4.69781 13.9808 5 14.1348L5.12988 14.1904C5.27366 14.2419 5.46311 14.2797 5.74512 14.3027C6.12864 14.3341 6.62197 14.335 7.33301 14.335H15L15.0674 14.3418L14.1123 13.3867L14.0273 13.2822C13.8571 13.0242 13.8854 12.6735 14.1123 12.4463C14.3397 12.2189 14.6911 12.1906 14.9492 12.3613L15.0537 12.4463L17.1367 14.5293C17.3964 14.7889 17.3963 15.21 17.1367 15.4697L15.0537 17.5537C14.794 17.8134 14.372 17.8134 14.1123 17.5537C13.8526 17.294 13.8526 16.872 14.1123 16.6123L15.0664 15.6582L15 15.665H7.33301C6.64392 15.665 6.08696 15.6647 5.63672 15.6279C5.23614 15.5952 4.87531 15.5309 4.53906 15.3867L4.39649 15.3193C3.87528 15.0538 3.43887 14.6502 3.13477 14.1543L3.0127 13.9365C2.82084 13.5599 2.74153 13.1541 2.7041 12.6963C2.66732 12.2461 2.66797 11.6889 2.66797 11ZM15.665 15C15.665 15.0226 15.6594 15.0444 15.6572 15.0664L15.7256 14.999L15.6572 14.9316C15.6595 14.9541 15.665 14.9769 15.665 15ZM11.666 8.91797L11.8008 8.93164C12.1036 8.99381 12.3311 9.2618 12.3311 9.58301C12.3311 9.90422 12.1036 10.1722 11.8008 10.2344L11.666 10.248H7.5C7.13273 10.248 6.83496 9.95028 6.83496 9.58301C6.83496 9.21574 7.13273 8.91797 7.5 8.91797H11.666ZM14.166 4.33496L14.3008 4.34863C14.6036 4.41083 14.8311 4.67881 14.8311 5C14.8309 5.32109 14.6035 5.58924 14.3008 5.65137L14.166 5.66504H7.5C7.13284 5.66504 6.83514 5.36712 6.83496 5C6.83496 4.63273 7.13273 4.33496 7.5 4.33496H14.166Z"
      fill="currentColor"
    />
  </svg>
);

const CodexSteerIcon: FC<{ className?: string }> = ({ className = "size-3.5 shrink-0" }) => (
  <svg className={className} width="14" height="14" viewBox="0 0 21 21" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
    <path
      d="M13.1293 7.34753C13.3565 7.12027 13.7081 7.09207 13.9662 7.26257L14.0707 7.34753L18.0707 11.3475C18.3304 11.6072 18.3304 12.0292 18.0707 12.2889L14.0707 16.2889C13.811 16.5486 13.389 16.5486 13.1293 16.2889C12.8696 16.0292 12.8696 15.6072 13.1293 15.3475L15.9935 12.4833H6.59998C4.57585 12.4833 2.93494 10.8424 2.93494 8.81824V5.31824C2.93494 4.95097 3.23271 4.6532 3.59998 4.6532C3.96724 4.6532 4.26501 4.95097 4.26501 5.31824V8.81824C4.26501 10.1078 5.31039 11.1532 6.59998 11.1532H15.9935L13.1293 8.28894L13.0443 8.18445C12.8738 7.92632 12.902 7.5748 13.1293 7.34753Z"
      fill="currentColor"
    />
  </svg>
);

const CodexMoreIcon: FC<{ className?: string }> = ({ className = "size-3.5 shrink-0" }) => (
  <svg className={className} width="14" height="14" viewBox="0 0 20 20" fill="currentColor" aria-hidden="true">
    <circle cx="4" cy="10" r="1.75" />
    <circle cx="10" cy="10" r="1.75" />
    <circle cx="16" cy="10" r="1.75" />
  </svg>
);

const QueueItemRow: FC<{ queueItem: QueueItemState; steering: boolean; onEdit: () => void }> = ({ queueItem, steering, onEdit }) => {
  const { t } = useLocale();
  return (
    <div
      role="listitem"
      className="q-composer-queue-item group flex min-h-[36px] min-w-0 items-center justify-between gap-2 px-3 py-1.5 text-xs text-foreground/85 transition-colors hover:bg-foreground/[0.04]"
    >
      <div
        className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 overflow-hidden"
        onClick={onEdit}
        title={queueItem.prompt}
      >
        <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground/70">
          <CodexQueueIcon />
        </span>
        <QueueItemPrimitive.Text
          className="min-w-0 flex-1 truncate text-xs leading-5 text-foreground/85 select-none"
          title={queueItem.prompt}
        />
      </div>
      {steering ? (
        <span className="shrink-0 text-xs text-muted-foreground">{t("chat.steerPending")}</span>
      ) : (
        <div className="flex shrink-0 items-center gap-1 text-muted-foreground">
          <QueueItemPrimitive.Steer asChild>
            <Button
              variant="ghost"
              size="icon-sm"
              title={t("chat.queueSteer")}
              aria-label={t("chat.queueSteer")}
              className="h-6 w-auto gap-1 rounded-md px-1.5 text-xs font-normal text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
            >
              <CodexSteerIcon className="size-3.5 shrink-0" />
              <span>{t("chat.queueSteer")}</span>
            </Button>
          </QueueItemPrimitive.Steer>
          <QueueItemPrimitive.Remove asChild>
            <TooltipIconButton
              tooltip={t("chat.queueRemove")}
              className="size-6 rounded-md text-muted-foreground transition-colors hover:bg-destructive/15 hover:text-destructive"
            >
              <Trash2Icon className="size-3.5" aria-hidden />
            </TooltipIconButton>
          </QueueItemPrimitive.Remove>
          <DropdownMenu.Root>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                title={t("chat.queueMore")}
                aria-label={t("chat.queueMore")}
                className="inline-flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground focus-visible:outline-none"
              >
                <CodexMoreIcon className="size-3.5" />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content
                className="q-sidebar-menu z-50 min-w-32 rounded-lg border border-border/60 bg-popover p-1 text-xs shadow-md"
                side="top"
                align="end"
                sideOffset={6}
              >
                <DropdownMenu.Item
                  className="q-sidebar-menu-item flex cursor-pointer items-center gap-2 rounded px-2 py-1.5 text-xs text-foreground outline-none hover:bg-foreground/10"
                  onSelect={onEdit}
                >
                  <PencilIcon className="size-3.5 text-muted-foreground" />
                  <span>{t("chat.queueEdit")}</span>
                </DropdownMenu.Item>
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        </div>
      )}
    </div>
  );
};

const Composer: FC<{ placeholder: string }> = ({ placeholder }) => {
  const aui = useAui();
  const { t } = useLocale();
  const sessionId = useStore((state) => state.currentSessionId);
  const compactSession = useStore((state) => state.compactSession);
  const compacting = useStore((state) => Boolean(state.currentSessionId && state.compactionStatuses[state.currentSessionId]));
  const editingQueueItem = useStore((state) => state.editingQueueItem);
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
        useStore.setState({ lastError: error instanceof Error ? error.message : String(error) });
      });
      else shellRef.current?.querySelector<HTMLButtonElement>(".aui-composer-add-attachment")?.click();
    }
    else if (tool.id === "folder") void pickNativeAttachmentFolder().then(onNativeFiles).catch((error) => {
      useStore.setState({ lastError: error instanceof Error ? error.message : String(error) });
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
                    await aui.composer().addAttachment(createNativeAttachmentFile(attachment.name, attachment.mimeType, attachment.localPath, 0, attachment.type === "folder"));
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
              <span>{t("chat.queueEditing")}</span>
              <button type="button" className="rounded px-1.5 py-0.5 hover:bg-foreground/10" onClick={() => { if (sessionId) getQoneMessageQueue(sessionId)?.cancelEdit(); useStore.setState({ editingQueueItem: undefined }); void aui.composer().reset(); }}>{t("common.cancel")}</button>
            </div>
          )}
          <ComposerAttachments />
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
  const goal = useStore((state) => state.goal);
  const pause = useStore((state) => state.pauseGoal);
  const resume = useStore((state) => state.resumeGoal);
  const clear = useStore((state) => state.clearGoal);
  if (!goal) return null;
  const status = goal.waitingReason ? t("goal.waiting") : goal.status === "active" ? t("goal.active") : goal.status === "paused" ? t("goal.paused") : goal.status === "blocked" ? t("goal.blocked") : t("goal.complete");
  return <div className="mx-auto mb-2 flex w-full q-composer-content items-center gap-2 rounded-xl border border-foreground/10 bg-muted/30 px-3 py-2 text-xs" role="status">
    <span className="flex min-w-0 flex-1 items-center gap-1.5"><TargetIcon className="size-3.5 shrink-0 text-primary" /><strong className="shrink-0">Goal · {status}</strong><span className="truncate text-muted-foreground" title={goal.objective}>{goal.objective}</span></span>
    {goal.status === "active" && !goal.waitingReason && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={pause}>{t("goal.pause")}</button>}
    {(goal.status === "paused" || goal.status === "blocked" || Boolean(goal.waitingReason)) && <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={resume}>{t("goal.resume")}</button>}
    <button type="button" className="shrink-0 rounded px-1.5 py-0.5 text-muted-foreground hover:bg-foreground/10 hover:text-foreground" onClick={clear}>{t("goal.clear")}</button>
  </div>;
};

const ComposerAction: FC<{ mentionOpen: boolean; onToggleMention: () => void }> = ({ mentionOpen, onToggleMention }) => {
  const { t } = useLocale();
  const isRunning = useAuiState((state) => state.thread.isRunning);
  const showSend = useAuiState((state) => !state.thread.isRunning || (state.thread.capabilities.queue && state.composer.canSend));
  const compacting = useStore((state) => Boolean(state.currentSessionId && state.compactionStatuses[state.currentSessionId]));
  const sendLabel = t(isRunning ? "chat.queueSend" : "chat.sendMessage");
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1">
        <ComposerToolsPopover open={mentionOpen} onToggle={onToggleMention} />
        <RunOptionsPopover />
      </div>
      <div className="flex items-center gap-1">
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

const ThreadScrollToBottom: FC = () => {
  const { t } = useLocale();
  return (
    <ThreadPrimitive.ScrollToBottom asChild>
      <TooltipIconButton
        tooltip={t("chat.scrollToBottom")}
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
    <MessagePrimitive.Root className="q-message-root q-message-user relative mx-auto flex w-full q-thread-content flex-col items-end gap-1">
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
    <MessagePrimitive.Root className="q-message-root q-message-user relative flex w-fit max-w-[75%] flex-col items-end gap-0.5 self-end">
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
    <div className="q-message-user-attachments flex w-fit max-w-[75%] min-w-0 flex-wrap items-end justify-end gap-2 self-end">
      <MessagePrimitive.Parts>
        {({ part }) => {
          if (part.type === "file") return <div className="w-48 max-w-full min-w-0"><File {...part} /></div>;
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

const AssistantMessage: FC<{ userMessageId?: string; showLatestExtras: boolean; betweenContent?: ReactNode }> = ({ userMessageId, showLatestExtras, betweenContent }) => {
  const { t } = useLocale();
  const messageId = useAuiState((state) => state.message.id);
  const answerError = useStore((state) => {
    const error = state.chatRunError;
    if (!error || error.sessionId !== state.currentSessionId) return undefined;
    return messageId === chatRunErrorMessageId(error.userMessageId) ? error : undefined;
  });
  const runId = useStore((state) => messageId === "streaming" ? state.activeRunId : state.messages.find((message) => message.id === messageId)?.runId);
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
        betweenContent={betweenContent}
        assistantContent={
          <MessagePrimitive.Root className="q-message-root q-message-assistant relative flex w-full flex-col">
            {answerError ? <div className="flex flex-col gap-1 text-sm leading-relaxed" role="alert">
              <p className="font-medium text-foreground">{t("chat.runFailed")}</p>
              <p className="whitespace-pre-wrap break-words text-muted-foreground">{answerError.detail || t("chat.runFailedDetail")}</p>
              <button type="button" className="mt-1 flex w-fit items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground" onClick={() => retryUserMessage(answerError.userMessageId)}>
                <RefreshCwIcon className="size-3.5" />{t("chat.retryMessage")}
              </button>
            </div> : <AssistantParts />}
            {!answerError && <>
              <GeneratedMediaArtifacts runIds={runIds} />
              <MessageSourcesView />
              <AssistantMemoryChips visible={showLatestExtras} />
              <AgentPreparation />
            </>}
          </MessagePrimitive.Root>
        }
        actions={answerError ? <></> :
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
          </div>
        }
      />
  );
};

const AgentPreparation: FC = () => {
  const { t } = useLocale();
  const activeRunId = useStore((state) => state.activeRunId);
  const compacting = useStore((state) => Boolean(activeRunId && state.currentSessionId
    && state.autoCompactionStatuses[state.currentSessionId]?.runId === activeRunId));
  const request = useStore((state) => state.modelRequest);
  const requestStartedAt = request?.runId === activeRunId ? request?.startedAt : undefined;
  const [now, setNow] = useState(Date.now);
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
  const parts = useAuiState((state) => state.message.parts);
  const tailPart = parts.at(-1);
  // The run can be active before Pi emits message.started. Keep this fallback
  // independent of activeMessageSequence so the first visible state is not a
  // blank assistant bubble.
  const hasReasoning = tailPart?.type === "reasoning" && tailPart.status.type === "running" && Boolean(tailPart.text.trim());
  const phase = assistantWaitingPhase({ messageRunning, compacting, hasCurrentText, hasReasoning, parts: streamingParts, toolCallsById, requestStartedAt });
  const candidate = phase !== undefined;
  const [visiblePhase, setVisiblePhase] = useState<string>();

  useEffect(() => {
    if (!candidate) {
      setVisiblePhase(undefined);
      return undefined;
    }
    const timer = setTimeout(() => setVisiblePhase(phaseKey), 400);
    return () => clearTimeout(timer);
  }, [candidate, phaseKey]);

  useEffect(() => {
    if (!candidate || requestStartedAt === undefined) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [candidate, requestStartedAt]);

  if (!candidate || visiblePhase !== phaseKey) return null;
  return (
    <div className="text-foreground/55 flex items-center py-1 text-sm" role="status" aria-live="polite">
      <ShimmerLabel active className="relative inline-block leading-none">
        {t(phase === "thinking" ? "chat.reasoningActive" : phase === "waiting" ? "chat.waitingResponse" : "chat.preparingRequest")}
      </ShimmerLabel>
      <EllipsisDots />
      {requestStartedAt !== undefined && <span className="ms-2 text-xs tabular-nums opacity-70" aria-hidden="true">{Math.max(0, Math.floor((now - requestStartedAt) / 1000))}s</span>}
    </div>
  );
};
