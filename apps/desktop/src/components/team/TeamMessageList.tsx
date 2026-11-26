import { useMemo, useRef } from "react";
import { AnimatePresence, motion } from "motion/react";
import { TextMessagePartProvider } from "@assistant-ui/react";
import { Crown, Laptop, Sparkles } from "lucide-react";
import { ContextMenu } from "radix-ui";
import type { ServerInfo } from "@qone/protocol";
import replyIcon from "../../assets/codex-icons/arrow-uturn-left-light-16.svg";
import copyIcon from "../../assets/codex-icons/square-on-square-light-16.svg";
import { contextMenuSelection, openContextMenuFromKeyboard } from "../../lib/context-menu";
import { localizeError } from "../../lib/error-localization";
import { splitMessageByMentions } from "../../lib/team/mentions";
import type { TeamBot, TeamBotPresence, TeamGroup, TeamMessage, TeamRunAction, TeamRunCard, TeamRunStep } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { cn } from "../../lib/utils";
import { CodexIcon, CodexServerIcon } from "../ui/CodexIcon";
import { MarkdownText } from "../assistant-ui/elements/markdown-text";
import { AgentRunStatusCard, shouldShowStepCard } from "./AgentRunStatusCard";
import { TeamAttachmentStrip } from "./TeamAttachmentStrip";
import { TeamAvatar } from "./TeamAvatar";
import { FadeScroll } from "../assistant-ui/elements/fade-scroll";
import { TeamMemberCard, type TeamMemberActions } from "./TeamMemberCard";
import "../assistant-ui/sidebar-menu.css";

interface TeamMessageListProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  botsById: ReadonlyMap<string, TeamBot>;
  serversById: ReadonlyMap<string, ServerInfo>;
  messages: readonly TeamMessage[];
  runs: readonly TeamRunCard[];
  presence: Record<string, TeamBotPresence>;
  memberActions: TeamMemberActions;
  onReply: (message: TeamMessage) => void;
  onQuickPrompt: (prompt: string) => void;
  onRunAction: (runId: string, action: TeamRunAction) => void;
}

function formatTime(timestamp: number, locale: string): string {
  return new Intl.DateTimeFormat(locale === "zh-CN" ? "zh-CN" : "en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(timestamp);
}

function RenderedMessageText({ message }: { message: TeamMessage }) {
  const segments = useMemo(
    () => splitMessageByMentions(message.content, message.mentions),
    [message.content, message.mentions],
  );
  return (
    <>
      {segments.map((segment) =>
        segment.kind === "mention" ? (
          <span key={`${segment.start}-${segment.value}`} className="team-mention-chip">
            {segment.value}
          </span>
        ) : (
          <span key={`t-${segment.start}`}>{segment.value}</span>
        ),
      )}
    </>
  );
}

interface BoundStepEntry {
  run: TeamRunCard;
  step: TeamRunStep;
  showRunControls: boolean;
}

function TeamMessageBubble({
  message,
  workspaceId,
  stepEntry,
  serversById,
  onReply,
  onRunAction,
}: {
  message: TeamMessage;
  workspaceId?: string;
  stepEntry?: BoundStepEntry;
  serversById: ReadonlyMap<string, ServerInfo>;
  onReply: TeamMessageListProps["onReply"];
  onRunAction: TeamMessageListProps["onRunAction"];
}) {
  const { t } = useLocale();
  const bubbleRef = useRef<HTMLDivElement>(null);
  const selectionRef = useRef("");
  const replyOnClose = useRef(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(selectionRef.current || message.content);
    } catch (error) {
      useStore.setState({ lastError: localizeError(error) });
    }
  };
  const isUser = message.senderKind === "user";
  const hasReplyText = message.content.trim().length > 0;
  const showStepCard = Boolean(!isUser && stepEntry && shouldShowStepCard(stepEntry.run, stepEntry.step, hasReplyText));

  return (
    <ContextMenu.Root onOpenChange={(open) => { if (open) selectionRef.current = contextMenuSelection(bubbleRef.current); }}>
      <ContextMenu.Trigger asChild ref={bubbleRef} onKeyDown={openContextMenuFromKeyboard}>
        <div
          className={cn(isUser ? "team-bubble-user" : "team-bubble-bot", showStepCard && "has-step-card")}
          role="group"
          aria-haspopup="menu"
          tabIndex={0}
        >
          {showStepCard && stepEntry && (
            <div className={message.content || message.streaming || message.attachments?.length ? "mb-2.5" : undefined}>
              <AgentRunStatusCard
                run={stepEntry.run}
                step={stepEntry.step}
                serversById={serversById}
                hasReplyText={hasReplyText}
                showRunControls={stepEntry.showRunControls}
                onAction={(action) => onRunAction(stepEntry.run.id, action)}
              />
            </div>
          )}
          {message.attachments?.length ? (
            <TeamAttachmentStrip attachments={message.attachments} workspaceId={workspaceId} className={message.content ? "mb-2" : undefined} />
          ) : null}
          {message.content ? (
            isUser ? (
              <RenderedMessageText message={message} />
            ) : (
              <TextMessagePartProvider text={message.content} isRunning={Boolean(message.streaming)}>
                <MarkdownText />
              </TextMessagePartProvider>
            )
          ) : null}
          {message.streaming && (
            <span
              className={message.content ? "team-typing-dots is-inline" : "team-typing-dots"}
              aria-hidden="true"
            >
              <span />
              <span />
              <span />
            </span>
          )}
        </div>
      </ContextMenu.Trigger>
      <ContextMenu.Portal>
        <ContextMenu.Content className="q-sidebar-menu" collisionPadding={8} onCloseAutoFocus={(event) => {
          if (!replyOnClose.current) return;
          replyOnClose.current = false;
          event.preventDefault();
          onReply(message);
        }}>
          <ContextMenu.Item className="q-sidebar-menu-item" onSelect={() => { replyOnClose.current = true; }}>
            <CodexIcon src={replyIcon} className="size-4" />
            {t("team.reply")}
          </ContextMenu.Item>
          <ContextMenu.Item className="q-sidebar-menu-item" disabled={!message.content} onSelect={() => void copy()}>
            <CodexIcon src={copyIcon} className="size-4" />
            {t("team.copy")}
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}

export function TeamMessageList({
  group,
  members,
  botsById,
  serversById,
  messages,
  runs,
  presence,
  memberActions,
  onReply,
  onQuickPrompt,
  onRunAction,
}: TeamMessageListProps) {
  const { t, locale } = useLocale();

  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  // 将每个成员步骤一对一绑定到各自对应的机器人回复气泡；兼容缺少 messageId 的旧记录。
  const { stepByMessageId, failedNoteByTriggerId } = useMemo(() => {
    const bound = new Map<string, BoundStepEntry>();
    const failedNotes = new Map<string, string>();
    const usedMessages = new Set<string>();

    // 记录每个触发用户消息对应的后续机器人消息区间（直到下一条用户消息为止）
    const botRepliesByTrigger = new Map<string, TeamMessage[]>();
    let currentTriggerId: string | undefined;
    for (const message of messages) {
      if (message.senderKind === "user") {
        currentTriggerId = message.id;
        botRepliesByTrigger.set(message.id, []);
      } else if (message.senderKind === "bot" && currentTriggerId) {
        botRepliesByTrigger.get(currentTriggerId)!.push(message);
      }
    }

    for (const run of runs) {
      const boundInRun: Array<{ messageId: string; step: TeamRunStep }> = [];
      const fallbackPool = botRepliesByTrigger.get(run.triggerMessageId) ?? [];

      for (const step of run.steps) {
        let messageId = step.messageId && messagesById.has(step.messageId) ? step.messageId : undefined;
        if (!messageId) {
          const candidate = fallbackPool.find((msg) => !usedMessages.has(msg.id) && msg.senderBotId === step.botId);
          messageId = candidate?.id;
        }
        if (messageId) {
          usedMessages.add(messageId);
          boundInRun.push({ messageId, step });
        }
      }

      // 将任务级控制栏挂到当前最活跃（或最后一个）步骤气泡，避免多个并发气泡重复出现控制条。
      const controlTarget =
        boundInRun.find(({ step }) => step.status === "running" || step.status === "paused" || step.status === "awaiting") ??
        boundInRun.at(-1);

      for (const { messageId, step } of boundInRun) {
        bound.set(messageId, { run, step, showRunControls: controlTarget?.messageId === messageId });
      }

      if (boundInRun.length === 0 && run.status === "failed" && run.note) {
        failedNotes.set(run.triggerMessageId, run.note);
      }
    }

    return { stepByMessageId: bound, failedNoteByTriggerId: failedNotes };
  }, [messages, messagesById, runs]);
  const coordinator = botsById.get(group.coordinatorBotId) ?? members[0];
  const boundServers = group.execution.serverIds
    .map((id) => serversById.get(id))
    .filter((server): server is ServerInfo => Boolean(server));

  // 由当前群实际成员动态构造快捷开场提示，不写死任何固定角色名。
  const quickPrompts = useMemo(() => {
    if (group.directBotId) return [];
    const prompts: string[] = [];
    if (coordinator) {
      prompts.push(t("team.welcome.promptCoordinate", { coordinator: coordinator.name }));
    }
    prompts.push(t("team.welcome.promptAll", { all: t("team.mentionAll") }));
    const secondary = members.find((bot) => bot.id !== coordinator?.id) ?? coordinator;
    if (secondary) {
      prompts.push(t("team.welcome.promptEnv", { target: secondary.name }));
    }
    return prompts;
  }, [coordinator, group.directBotId, members, t]);

  if (messages.length === 0) {
    return (
      <FadeScroll className="team-message-stream">
        <div className="mx-auto flex min-h-full max-w-[660px] flex-col items-center justify-center py-10 text-center">
          <div className="flex items-center justify-center gap-2">
            {members.slice(0, 6).map((bot) => (
              <TeamMemberCard key={bot.id} bot={bot} actions={memberActions} presence={presence[bot.id] ?? "idle"} coordinator={!group.directBotId && bot.id === group.coordinatorBotId}>
                <motion.button
                  type="button"
                  whileHover={{ y: -3, scale: 1.04 }}
                  transition={{ duration: 0.16 }}
                  className="flex flex-col items-center gap-1.5 rounded-2xl border border-border/75 bg-card px-3 py-2.5 shadow-xs hover:border-foreground/25"
                >
                  <div className="relative">
                    <TeamAvatar bot={{ ...bot, name: "" }} size={44} />
                    {!group.directBotId && bot.id === group.coordinatorBotId && (
                      <span className="absolute -top-1 -right-1 inline-flex size-4 items-center justify-center rounded-full bg-amber-500 text-white shadow-xs">
                        <Crown size={9} />
                      </span>
                    )}
                  </div>
                  <span className="max-w-16 truncate text-xs font-medium text-foreground">{bot.name}</span>
                  <span className="max-w-16 truncate text-[10px] text-muted-foreground">{bot.roleTitle}</span>
                </motion.button>
              </TeamMemberCard>
            ))}
          </div>

          <h2 className="mt-6 text-lg font-semibold tracking-tight text-foreground">
            {group.directBotId ? group.name : t("team.welcome.title", { name: group.name })}
          </h2>

          <div className="mt-4 inline-flex flex-wrap items-center justify-center gap-2 text-xs text-muted-foreground">
            <span className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/45 px-2.5 py-1">
              <Laptop size={12} />
              {t("team.env.local")}
            </span>
            {boundServers.map((server) => (
              <span
                key={server.id}
                className="inline-flex items-center gap-1.5 rounded-full border border-sky-500/30 bg-sky-500/8 px-2.5 py-1 text-sky-700 dark:text-sky-300"
              >
                <CodexServerIcon className="size-3" />
                {server.name}
              </span>
            ))}
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
            {quickPrompts.map((prompt) => (
              <button
                key={prompt}
                type="button"
                onClick={() => onQuickPrompt(prompt)}
                className="inline-flex items-center gap-1.5 rounded-full border border-border bg-background px-3.5 py-1.5 text-xs text-foreground transition-colors hover:border-foreground/30 hover:bg-accent"
              >
                <Sparkles size={12} className="text-muted-foreground" />
                <span>{prompt}</span>
              </button>
            ))}
          </div>
        </div>
      </FadeScroll>
    );
  }

  return (
    <FadeScroll className="team-message-stream" autoScrollToBottom>
      <div className="team-message-inner">
        <AnimatePresence initial={false}>
          {messages.map((message) => {
            const isUser = message.senderKind === "user";
            const senderBot = message.senderBotId ? botsById.get(message.senderBotId) : undefined;
            const replyTarget = message.replyToMessageId
              ? messagesById.get(message.replyToMessageId)
              : undefined;
            const replySenderName = replyTarget
              ? replyTarget.senderKind === "user"
                ? t("team.you")
                : botsById.get(replyTarget.senderBotId ?? "")?.name ?? ""
              : "";
            const isCoordinator = !group.directBotId && senderBot?.id === group.coordinatorBotId;

            return (
              <motion.div
                key={message.id}
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ duration: 0.18 }}
                className="flex flex-col gap-2.5"
              >
                {message.senderKind === "system" ? (
                  <div className="mx-auto rounded-full bg-muted/70 px-3 py-1 text-[11.5px] text-muted-foreground">
                    {message.content}
                  </div>
                ) : isUser ? (
                  <>
                    <div className="flex flex-col items-end gap-1">
                      <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                        <time className="tabular-nums">{formatTime(message.createdAt, locale)}</time>
                        <span className="font-medium text-foreground">{t("team.you")}</span>
                      </div>

                      {replyTarget && (
                        <div className="max-w-[70%] truncate rounded-lg border border-border/70 bg-muted/50 px-2.5 py-1 text-[11.5px] text-muted-foreground">
                          <span className="font-medium text-foreground">{replySenderName}: </span>
                          {replyTarget.content}
                        </div>
                      )}

                      <TeamMessageBubble
                        message={message}
                        workspaceId={group.execution.workspaceId}
                        serversById={serversById}
                        onReply={onReply}
                        onRunAction={onRunAction}
                      />
                    </div>

                    {failedNoteByTriggerId.get(message.id) && (
                      <div className="mx-auto rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-1.5 text-[11.5px] text-destructive">
                        {failedNoteByTriggerId.get(message.id)}
                      </div>
                    )}
                  </>
                ) : (
                  <div className="flex items-start gap-2.5">
                    {senderBot ? (
                      <TeamMemberCard
                        bot={senderBot}
                        actions={memberActions}
                        presence={presence[senderBot.id] ?? "idle"}
                        coordinator={isCoordinator}
                        canMention={group.memberBotIds.includes(senderBot.id)}
                      >
                        <button type="button" aria-label={senderBot.name} className="mt-0.5 shrink-0 rounded-full transition-transform hover:scale-105">
                          <TeamAvatar bot={{ ...senderBot, name: "" }} size={36} />
                        </button>
                      </TeamMemberCard>
                    ) : (
                      <span className="mt-0.5 inline-flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground">
                        <Sparkles size={14} />
                      </span>
                    )}

                    <div className="flex min-w-0 flex-1 flex-col items-start gap-1">
                      <div className="flex flex-wrap items-center gap-1.5 text-[11.5px]">
                        <strong className="font-semibold text-foreground">
                          {senderBot?.name ?? "Bot"}
                        </strong>
                        {senderBot?.roleTitle && (
                          <span className="rounded-md bg-muted px-1.5 py-0.5 text-[10.5px] text-muted-foreground">
                            {senderBot.roleTitle}
                          </span>
                        )}
                        {isCoordinator && (
                          <span className="inline-flex items-center gap-0.5 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                            <Crown size={10} />
                            {t("team.coordinator")}
                          </span>
                        )}
                        <time className="text-[11px] text-muted-foreground tabular-nums">
                          {formatTime(message.createdAt, locale)}
                        </time>
                      </div>

                      {replyTarget && (
                        <div className="max-w-[78%] truncate rounded-lg border border-border/70 bg-muted/45 px-2.5 py-1 text-[11.5px] text-muted-foreground">
                          <span className="font-medium text-foreground">{replySenderName}: </span>
                          {replyTarget.content}
                        </div>
                      )}

                      <TeamMessageBubble
                        message={message}
                        workspaceId={group.execution.workspaceId}
                        stepEntry={stepByMessageId.get(message.id)}
                        serversById={serversById}
                        onReply={onReply}
                        onRunAction={onRunAction}
                      />
                    </div>
                  </div>
                )}
              </motion.div>
            );
          })}
        </AnimatePresence>
      </div>
    </FadeScroll>
  );
}
