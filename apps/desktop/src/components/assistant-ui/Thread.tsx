import { ComposerAttachments, ComposerAddAttachment } from "./elements/attachment.aui";
import { File } from "./elements/file";
import { UserImageThumbnail } from "./elements/user-image-thumbnail";
import { ComposerToolChip, ComposerToolsPopover, type ComposerTool } from "./composer-tools";
import { ComposerTriggers } from "./composer-triggers";
import { ComposerEditorBridge, type InsertComposerTool, type ToggleComposerMention } from "./composer-editor-bridge";
import { LongPasteAttachmentPlugin } from "./long-paste-attachment";
import { MarkdownText } from "./markdown-text";
import { MessagePair } from "./elements/message-pair";
import { DaySeparatorMarker } from "./elements/day-separator";
import { ErrorState } from "./elements/error-state";
import { pairMessageIds } from "./message-pairing";
import { messageDaySeparators } from "./message-day-separators";
import { GenerativeUIPresentation, SessionTimeline } from "./session-timeline";
import { assistantPartRanges } from "./assistant-part-ranges";
import { MessageSourcesView } from "./message-sources-view";
import { AssistantContext, AssistantMemoryChips } from "./assistant-context";
import { TooltipIconButton } from "./tooltip-icon-button";
import { Button } from "../ui/Button";
import { cn } from "../../lib/utils";
import { ModelPicker } from "./model-picker";
import { RunOptionsPopover } from "./run-options-popover";
import { ShimmerLabel } from "./elements/surfaces";
import { ComposerLoadingSkeleton, ConversationLoadingSkeleton } from "./loading-skeleton";
import "./thread-viewport.css";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { useNativeFileDrop } from "../../lib/native-file-drop";
import {
  ActionBarPrimitive,
  AuiIf,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAui,
  useAuiState,
} from "@assistant-ui/react";
import { LexicalComposerInput } from "@assistant-ui/react-lexical";
import {
  ArrowUpIcon,
  CheckIcon,
  ChevronDownIcon,
  CopyIcon,
  MicIcon,
  RefreshCwIcon,
  SquareIcon,
  FolderPlusIcon,
  Loader2Icon,
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
  const pairedUserIdByAssistant = useMemo(() => pairMessageIds(threadMessages), [threadMessages]);
  const pairedUserIds = useMemo(() => new Set(pairedUserIdByAssistant.values()), [pairedUserIdByAssistant]);
  const latestAssistantId = useMemo(
    () => [...threadMessages].reverse().find((message) => message.role === "assistant")?.id,
    [threadMessages],
  );
  const daySeparators = useMemo(() => messageDaySeparators(threadMessages, pairedUserIdByAssistant), [threadMessages, pairedUserIdByAssistant]);
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
        ["--composer-bg" as string]: "color-mix(in oklab, var(--color-muted) 40%, var(--color-background))",
        ["--composer-radius" as string]: "var(--radius-thread)",
        ["--composer-padding" as string]: "8px",
      }}
    >
      {conversationLoading ? (
        <>
          <ConversationLoadingSkeleton />
          <div className="mx-auto w-full max-w-2xl px-4 pb-2">
            {canChat ? <Composer placeholder={t("chat.placeholder")} /> : <ComposerLoadingSkeleton />}
          </div>
        </>
      ) : <>
      <AuiIf condition={(s) => s.thread.isEmpty}>
        <EmptyState canChat={canChat} creatingSession={creatingSession} />
      </AuiIf>

      <AuiIf condition={(s) => !s.thread.isEmpty}>
        <ThreadPrimitive.Viewport turnAnchor="top" className="aui-viewport flex min-h-0 grow flex-col gap-7 overflow-y-auto">
          <ThreadPrimitive.Messages>
            {({ message }) => {
              if (message.role === "user" && pairedUserIds.has(message.id)) return null;
              const date = daySeparators.get(message.id);
              return (
                <div className="flex w-full flex-col gap-5">
                  {date && <DaySeparatorMarker day={dayFormatter.format(date)} className="mx-auto max-w-2xl" />}
                  {message.role === "user"
                    ? <UserMessage messageId={message.id} />
                    : <AssistantMessage
                      userMessageId={pairedUserIdByAssistant.get(message.id)}
                      showLatestExtras={message.id === latestAssistantId}
                    />}
                </div>
              );
            }}
          </ThreadPrimitive.Messages>
          <ChatRunErrorView />
          <div className="mx-auto w-full max-w-2xl empty:hidden">{children}</div>

          <ThreadPrimitive.ViewportFooter className="q-chat-footer sticky bottom-0 mt-auto flex w-full flex-col overflow-visible pb-2">
            <ThreadScrollToBottom />
            <div className="relative z-1 mx-auto w-full max-w-2xl">
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
      <div className="mx-auto flex w-full max-w-2xl flex-col items-stretch gap-5">
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

const Composer: FC<{ placeholder: string }> = ({ placeholder }) => {
  const aui = useAui();
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
  const onToolSelect = useCallback((tool: ComposerTool) => { if (tool.id === "attachment") shellRef.current?.querySelector<HTMLButtonElement>(".aui-composer-add-attachment")?.click(); else insertToolRef.current?.(tool); }, []);
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
    <ComposerPrimitive.Root className="aui-composer-root relative flex w-full flex-col">
      <ComposerPrimitive.Unstable_TriggerPopoverRoot>
      <ComposerPrimitive.AttachmentDropzone asChild>
        <div
          ref={shellRef}
          data-slot="aui_composer-shell"
          className="border-foreground/10 focus-within:border-foreground/25 data-[dragging=true]:border-ring flex w-full cursor-text flex-col gap-1 rounded-(--composer-radius) border bg-(--composer-bg) p-(--composer-padding) transition-[border-color] data-[dragging=true]:border-dashed data-[dragging=true]:bg-[color-mix(in_oklab,var(--color-accent)_50%,var(--color-background))]"
        >
          <ComposerAttachments />
          <ComposerAddAttachment hidden />
          <LexicalComposerInput autoFocus placeholder={placeholder} className={composerInputClass} directiveChip={ComposerToolChip}>
            <ComposerEditorBridge onReady={onEditorReady} onMentionToggleReady={onMentionToggleReady} />
            <LongPasteAttachmentPlugin />
          </LexicalComposerInput>
          <ComposerTriggers onToolSelect={onToolSelect} onMentionStateChange={onMentionStateChange} />
          <ComposerAction anchorRef={shellRef} mentionOpen={mentionOpen} onToggleMention={toggleMention} />
        </div>
      </ComposerPrimitive.AttachmentDropzone>
      </ComposerPrimitive.Unstable_TriggerPopoverRoot>
    </ComposerPrimitive.Root>
  );
};

const ComposerAction: FC<{ anchorRef: RefObject<HTMLDivElement | null>; mentionOpen: boolean; onToggleMention: () => void }> = ({ anchorRef, mentionOpen, onToggleMention }) => {
  return (
    <div className="aui-composer-action-wrapper relative flex items-center justify-between">
      <div className="flex items-center gap-1">
        <ComposerToolsPopover open={mentionOpen} onToggle={onToggleMention} />
        <ModelPicker />
      </div>
      <div className="flex items-center gap-1.5">
        <RunOptionsPopover anchorRef={anchorRef} />
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
        <AuiIf condition={(s) => !s.thread.isRunning}>
          <ComposerPrimitive.Send asChild>
            <TooltipIconButton
              tooltip="Send message"
              side="bottom"
              type="button"
              variant="default"
              size="icon"
              className="aui-composer-send size-7 rounded-full dark:text-black disabled:bg-muted-foreground disabled:text-black disabled:opacity-100"
              aria-label="Send message"
            >
              <ArrowUpIcon className="aui-composer-send-icon size-4" />
            </TooltipIconButton>
          </ComposerPrimitive.Send>
        </AuiIf>
        <AuiIf condition={(s) => s.thread.isRunning}>
          <ComposerPrimitive.Cancel asChild>
            <Button type="button" variant="default" size="icon" className="aui-composer-cancel size-7 rounded-full" aria-label="Stop generating">
              <SquareIcon className="aui-composer-cancel-icon size-3.5 fill-current" />
            </Button>
          </ComposerPrimitive.Cancel>
        </AuiIf>
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
  "flex size-7 items-center justify-center rounded-md text-[#6f6f6f] transition-colors hover:bg-black/[0.07] hover:text-[#333] dark:text-[#a6a6a6] dark:hover:bg-white/10 dark:hover:text-[#ececec]";

const retryUserMessage = (messageId: string) => {
  const state = useStore.getState();
  const source = state.messages.find((message) => message.id === messageId && message.role === "user");
  if (source) state.runAgent(source.content, source.id, source.attachments);
};

const UserMessageText: FC<{ paired?: boolean }> = ({ paired = false }) => {
  const hasText = useAuiState((state) => state.message.parts.some(
    (part) => part.type === "text" && part.text.length > 0,
  ));
  if (!hasText) return null;

  return (
    <div className={cn("w-fit min-w-0 break-words rounded-[18px] bg-[#0d0d0d] px-3.5 py-2 text-start text-sm leading-[1.5] text-white dark:bg-[#2a2a2a] dark:text-[#f5f5f5]", paired ? "max-w-full" : "max-w-[85%]")}>
      <MessagePrimitive.Parts>
        {({ part }) => part.type === "text" ? <span className="whitespace-pre-wrap">{part.text}</span> : null}
      </MessagePrimitive.Parts>
    </div>
  );
};

const UserMessage: FC<{ messageId: string }> = ({ messageId }) => {
  const { t } = useLocale();
  return (
    <MessagePrimitive.Root className="q-message-root q-message-user relative mx-auto flex w-full max-w-2xl flex-col items-end gap-0.5">
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
    <MessagePrimitive.Root className="q-message-root q-message-user relative flex w-fit max-w-[85%] flex-col items-end gap-0.5 self-end">
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
    <div className="q-message-user-attachments flex w-fit max-w-[85%] min-w-0 flex-nowrap items-end gap-2 self-end overflow-x-auto overscroll-x-contain pb-1">
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
        className="aui-message-pair mx-auto w-full max-w-2xl gap-5"
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
            <AssistantParts />
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
  // The run can be active before Pi emits message.started. Keep this fallback
  // independent of activeMessageSequence so the first visible state is not a
  // blank assistant bubble.
  const candidate = messageRunning && !hasCurrentText && !hasUnfinishedTool;
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
        {t("chat.toolPreparingNext")}
      </ShimmerLabel>
    </div>
  );
};

const AssistantParts: FC = () => {
  const parts = useAuiState((state) => state.message.parts);
  const ranges = useMemo(() => assistantPartRanges(parts), [parts]);
  return <>{ranges.map((range) => {
    if (range.type === "text") return (
      <div className="q-assistant-text text-foreground" key={`text-${range.index}`}>
        <MessagePrimitive.PartByIndex index={range.index} components={{ Text: MarkdownText }} />
      </div>
    );
    if (range.type === "presentation") return <GenerativeUIPresentation key={`present-${range.index}`} index={range.index} />;
    return <SessionTimeline key={`tools-${range.startIndex}`} startIndex={range.startIndex} endIndex={range.endIndex} />;
  })}</>;
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
    <div className="mx-auto w-full max-w-2xl">
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
