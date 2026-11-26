import { useMemo, useState } from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  AtSign,
  Check,
  Copy,
  CornerUpLeft,
  Crown,
  Laptop,
  Sparkles,
} from "lucide-react";
import type { ServerInfo } from "@qone/protocol";
import { splitMessageByMentions } from "../../lib/team/mentions";
import type { TeamBot, TeamGroup, TeamMessage, TeamRunCard } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { CodexServerIcon } from "../ui/CodexIcon";
import { SubagentLogo } from "../settings/subagent-logo";
import { FadeScroll } from "../assistant-ui/elements/fade-scroll";
import { AgentRunStatusCard } from "./AgentRunStatusCard";

interface TeamMessageListProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  botsById: ReadonlyMap<string, TeamBot>;
  serversById: ReadonlyMap<string, ServerInfo>;
  messages: readonly TeamMessage[];
  runs: readonly TeamRunCard[];
  onReply: (message: TeamMessage) => void;
  onMentionBot: (bot: TeamBot) => void;
  onQuickPrompt: (prompt: string) => void;
  onRunAction: (runId: string, action: "pause" | "resume" | "cancel") => void;
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

export function TeamMessageList({
  group,
  members,
  botsById,
  serversById,
  messages,
  runs,
  onReply,
  onMentionBot,
  onQuickPrompt,
  onRunAction,
}: TeamMessageListProps) {
  const { t, locale } = useLocale();
  const [copiedId, setCopiedId] = useState<string | null>(null);

  const messagesById = useMemo(
    () => new Map(messages.map((message) => [message.id, message])),
    [messages],
  );
  const runsById = useMemo(() => new Map(runs.map((run) => [run.id, run])), [runs]);
  const coordinator = botsById.get(group.coordinatorBotId) ?? members[0];
  const boundServers = group.execution.serverIds
    .map((id) => serversById.get(id))
    .filter((server): server is ServerInfo => Boolean(server));

  const handleCopy = (message: TeamMessage) => {
    void navigator.clipboard.writeText(message.content);
    setCopiedId(message.id);
    window.setTimeout(() => setCopiedId((prev) => (prev === message.id ? null : prev)), 1400);
  };

  // 由当前群实际成员动态构造快捷开场提示，不写死任何固定角色名。
  const quickPrompts = useMemo(() => {
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
  }, [coordinator, members, t]);

  if (messages.length === 0) {
    return (
      <FadeScroll className="team-message-stream">
        <div className="mx-auto flex min-h-full max-w-[660px] flex-col items-center justify-center py-10 text-center">
          <div className="flex items-center justify-center gap-2">
            {members.slice(0, 6).map((bot) => (
              <motion.button
                key={bot.id}
                type="button"
                whileHover={{ y: -3, scale: 1.04 }}
                transition={{ duration: 0.16 }}
                onClick={() => onMentionBot(bot)}
                className="group/card flex flex-col items-center gap-1.5 rounded-2xl border border-border/75 bg-card px-3 py-2.5 shadow-xs hover:border-foreground/25"
                title={bot.description || bot.roleTitle}
              >
                <div className="relative">
                  <SubagentLogo logo={bot.logo} name={bot.name} size={36} />
                  {bot.id === group.coordinatorBotId && (
                    <span className="absolute -top-1 -right-1 inline-flex size-4 items-center justify-center rounded-full bg-amber-500 text-white shadow-xs">
                      <Crown size={9} />
                    </span>
                  )}
                </div>
                <span className="max-w-16 truncate text-xs font-medium text-foreground">{bot.name}</span>
                <span className="max-w-16 truncate text-[10px] text-muted-foreground">{bot.roleTitle}</span>
              </motion.button>
            ))}
          </div>

          <h2 className="mt-6 text-lg font-semibold tracking-tight text-foreground">
            {t("team.welcome.title", { name: group.name })}
          </h2>
          <p className="mt-1.5 max-w-md text-[13px] leading-relaxed text-muted-foreground">
            {t("team.welcome.desc", { coordinator: coordinator?.name ?? "" })}
          </p>

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
            const attachedRun = message.runCardId ? runsById.get(message.runCardId) : undefined;

            return (
              <motion.div
                key={message.id}
                layout="position"
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
                  <div className="group/msg flex flex-col items-end gap-1">
                    <div className="flex items-center gap-2 text-[11px] text-muted-foreground">
                      <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
                        <button
                          type="button"
                          onClick={() => onReply(message)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                        >
                          <CornerUpLeft size={11} />
                          {t("team.reply")}
                        </button>
                        <button
                          type="button"
                          onClick={() => handleCopy(message)}
                          className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 hover:bg-accent hover:text-foreground"
                        >
                          {copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}
                          {t(copiedId === message.id ? "team.copied" : "team.copy")}
                        </button>
                      </div>
                      <time className="tabular-nums">{formatTime(message.createdAt, locale)}</time>
                      <span className="font-medium text-foreground">{t("team.you")}</span>
                    </div>

                    {replyTarget && (
                      <div className="max-w-[70%] truncate rounded-lg border border-border/70 bg-muted/50 px-2.5 py-1 text-[11.5px] text-muted-foreground">
                        <span className="font-medium text-foreground">{replySenderName}: </span>
                        {replyTarget.content}
                      </div>
                    )}

                    <div className="team-bubble-user">
                      <RenderedMessageText message={message} />
                    </div>
                  </div>
                ) : (
                  <div className="group/msg flex items-start gap-2.5">
                    {senderBot ? (
                      <button
                        type="button"
                        onClick={() => onMentionBot(senderBot)}
                        title={`@${senderBot.name}`}
                        className="mt-0.5 shrink-0 transition-transform hover:scale-105"
                      >
                        <SubagentLogo logo={senderBot.logo} name={senderBot.name} size={32} />
                      </button>
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
                        {senderBot?.id === group.coordinatorBotId && (
                          <span className="inline-flex items-center gap-0.5 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-700 dark:text-amber-300">
                            <Crown size={10} />
                            {t("team.coordinator")}
                          </span>
                        )}
                        <time className="text-[11px] text-muted-foreground tabular-nums">
                          {formatTime(message.createdAt, locale)}
                        </time>

                        <div className="ml-1 flex items-center gap-1 opacity-0 transition-opacity group-hover/msg:opacity-100">
                          <button
                            type="button"
                            onClick={() => onReply(message)}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            <CornerUpLeft size={11} />
                            {t("team.reply")}
                          </button>
                          {senderBot && (
                            <button
                              type="button"
                              onClick={() => onMentionBot(senderBot)}
                              className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                            >
                              <AtSign size={11} />
                              {t("team.mentionThis")}
                            </button>
                          )}
                          <button
                            type="button"
                            onClick={() => handleCopy(message)}
                            className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[11px] text-muted-foreground hover:bg-accent hover:text-foreground"
                          >
                            {copiedId === message.id ? <Check size={11} /> : <Copy size={11} />}
                            {t(copiedId === message.id ? "team.copied" : "team.copy")}
                          </button>
                        </div>
                      </div>

                      {replyTarget && (
                        <div className="max-w-[78%] truncate rounded-lg border border-border/70 bg-muted/45 px-2.5 py-1 text-[11.5px] text-muted-foreground">
                          <span className="font-medium text-foreground">{replySenderName}: </span>
                          {replyTarget.content}
                        </div>
                      )}

                      <div className="team-bubble-bot">
                        <RenderedMessageText message={message} />
                      </div>
                    </div>
                  </div>
                )}

                {attachedRun && (
                  <div className="pl-0 sm:pl-2">
                    <AgentRunStatusCard
                      run={attachedRun}
                      botsById={botsById}
                      serversById={serversById}
                      onAction={(action) => onRunAction(attachedRun.id, action)}
                    />
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
