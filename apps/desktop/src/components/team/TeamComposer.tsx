import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUp,
  AtSign,
  CornerUpLeft,
  Crown,
  Laptop,
  Plus,
  Users,
  X,
} from "lucide-react";
import type { ServerInfo } from "@qone/protocol";
import {
  applyMentionSelection,
  detectActiveMention,
  extractMentionsFromText,
  type ActiveMentionQuery,
} from "../../lib/team/mentions";
import type { TeamBot, TeamGroup, TeamMentionRef, TeamMessage } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { CodexServerIcon } from "../ui/CodexIcon";
import { SubagentLogo } from "../settings/subagent-logo";

export interface TeamComposerHandle {
  insertMention: (label: string) => void;
  setDraft: (value: string) => void;
  focus: () => void;
}

interface TeamComposerProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  servers: readonly ServerInfo[];
  replyTo?: TeamMessage;
  replySenderName?: string;
  onCancelReply: () => void;
  onSend: (content: string, mentions: TeamMentionRef[]) => void;
  onOpenServerPicker: () => void;
  onOpenCreateAndAddBot: () => void;
}

interface MentionOption {
  key: string;
  kind: "all" | "bot";
  label: string;
  subtitle: string;
  isCoordinator?: boolean;
  bot?: TeamBot;
}

export const TeamComposer = forwardRef<TeamComposerHandle, TeamComposerProps>(
  function TeamComposer(
    {
      group,
      members,
      servers,
      replyTo,
      replySenderName,
      onCancelReply,
      onSend,
      onOpenServerPicker,
      onOpenCreateAndAddBot,
    },
    ref,
  ) {
    const { t } = useLocale();
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const [text, setText] = useState("");
    const [caret, setCaret] = useState(0);
    const [activeMention, setActiveMention] = useState<ActiveMentionQuery | null>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);

    const allLabel = t("team.mentionAll");
    const allLabels = useMemo(() => [...new Set([allLabel, "全体成员", "全体", "Everyone", "all"])], [allLabel]);

    const parsedMentions = useMemo(
      () => extractMentionsFromText(text, members, allLabels),
      [text, members, allLabels],
    );

    const boundServers = useMemo(
      () => servers.filter((server) => group.execution.serverIds.includes(server.id)),
      [servers, group.execution.serverIds],
    );

    const mentionOptions = useMemo<MentionOption[]>(() => {
      const q = activeMention?.query.trim().toLocaleLowerCase() ?? "";
      const allOption: MentionOption = {
        key: "all",
        kind: "all",
        label: allLabel,
        subtitle: t("team.mentionAllDesc"),
      };
      const botOptions: MentionOption[] = [...members]
        .sort((left, right) => Number(right.id === group.coordinatorBotId) - Number(left.id === group.coordinatorBotId))
        .map((bot) => ({
          key: bot.id,
          kind: "bot",
          label: bot.name,
          subtitle: bot.id === group.coordinatorBotId ? t("team.mentionCoordinatorDesc") : bot.roleTitle || bot.description,
          isCoordinator: bot.id === group.coordinatorBotId,
          bot,
        }));
      const list = [allOption, ...botOptions];
      if (!q) return list;
      return list.filter((option) =>
        `${option.label} ${option.subtitle} ${option.bot?.capabilities.join(" ") ?? ""}`
          .toLocaleLowerCase()
          .includes(q),
      );
    }, [activeMention, allLabel, group.coordinatorBotId, members, t]);

    const activeHighlight =
      mentionOptions.length > 0 ? Math.min(highlightedIndex, mentionOptions.length - 1) : 0;

    // 根据内容自动调整输入框高度，避免出现笨重滚动条。
    const resizeTextarea = useCallback(() => {
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.style.height = "auto";
        element.style.height = `${Math.min(180, Math.max(44, element.scrollHeight))}px`;
      });
    }, []);

    const focusAt = useCallback((position: number) => {
      requestAnimationFrame(() => {
        const element = textareaRef.current;
        if (!element) return;
        element.focus();
        element.setSelectionRange(position, position);
        setCaret(position);
        element.style.height = "auto";
        element.style.height = `${Math.min(180, Math.max(44, element.scrollHeight))}px`;
      });
    }, []);

    const insertMentionAtCaret = useCallback(
      (label: string) => {
        const token = `@${label} `;
        const currentCaret = textareaRef.current?.selectionStart ?? caret;
        const before = text.slice(0, currentCaret);
        const after = text.slice(currentCaret);
        const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
        const nextText = `${before}${spacer}${token}${after}`;
        const nextCaret = before.length + spacer.length + token.length;
        setText(nextText);
        setActiveMention(null);
        setHighlightedIndex(0);
        focusAt(nextCaret);
      },
      [caret, focusAt, text],
    );

    useImperativeHandle(
      ref,
      () => ({
        insertMention: insertMentionAtCaret,
        setDraft: (value: string) => {
          setText(value);
          setActiveMention(null);
          setHighlightedIndex(0);
          focusAt(value.length);
        },
        focus: () => textareaRef.current?.focus(),
      }),
      [focusAt, insertMentionAtCaret],
    );

    const handleTextChange = (nextValue: string, nextCaret: number) => {
      setText(nextValue);
      setCaret(nextCaret);
      setActiveMention(detectActiveMention(nextValue, nextCaret));
      setHighlightedIndex(0);
      resizeTextarea();
    };

    const pickOption = (option: MentionOption) => {
      if (!activeMention) {
        insertMentionAtCaret(option.label);
        return;
      }
      const { nextText, nextCaret } = applyMentionSelection(text, activeMention, option.label);
      setText(nextText);
      setActiveMention(null);
      focusAt(nextCaret);
    };

    const removeMentionChip = (mention: TeamMentionRef) => {
      const escaped = mention.label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const next = text.replace(new RegExp(`@${escaped}\\s?`, "gi"), "").trimStart();
      setText(next);
      setActiveMention(null);
      textareaRef.current?.focus();
    };

    const triggerMentionMenu = () => {
      const element = textareaRef.current;
      const pos = element?.selectionStart ?? text.length;
      const before = text.slice(0, pos);
      const after = text.slice(pos);
      const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
      const nextText = `${before}${spacer}@${after}`;
      const nextCaret = before.length + spacer.length + 1;
      setText(nextText);
      setCaret(nextCaret);
      setActiveMention({ start: nextCaret - 1, end: nextCaret, query: "" });
      focusAt(nextCaret);
    };

    const submit = () => {
      const trimmed = text.trim();
      if (!trimmed) return;
      onSend(trimmed, parsedMentions);
      setText("");
      setCaret(0);
      setActiveMention(null);
      setHighlightedIndex(0);
      resizeTextarea();
      onCancelReply();
    };

    const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if (activeMention) {
        if (event.key === "ArrowDown") {
          event.preventDefault();
          if (mentionOptions.length > 0) {
            setHighlightedIndex((prev) => (prev + 1) % mentionOptions.length);
          }
          return;
        }
        if (event.key === "ArrowUp") {
          event.preventDefault();
          if (mentionOptions.length > 0) {
            setHighlightedIndex((prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length);
          }
          return;
        }
        if ((event.key === "Enter" || event.key === "Tab") && mentionOptions[activeHighlight]) {
          event.preventDefault();
          pickOption(mentionOptions[activeHighlight]);
          return;
        }
        if (event.key === "Escape") {
          event.preventDefault();
          setActiveMention(null);
          return;
        }
      }

      if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
        event.preventDefault();
        submit();
      }
    };

    return (
      <div className="team-composer-wrap shrink-0">
        <div className="team-composer-box">
          {/* @ 成员弹层 */}
          <AnimatePresence>
            {activeMention && (
              <motion.div
                initial={{ opacity: 0, y: 6, scale: 0.99 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={{ opacity: 0, y: 4, scale: 0.99 }}
                transition={{ duration: 0.14 }}
                className="team-mention-popover"
                role="listbox"
                aria-label={t("team.mentionButton")}
              >
                {mentionOptions.length > 0 ? (
                  <div className="flex flex-col gap-0.5">
                    {mentionOptions.map((option, index) => (
                      <button
                        key={option.key}
                        type="button"
                        role="option"
                        aria-selected={index === activeHighlight}
                        onMouseDown={(event) => {
                          event.preventDefault();
                          pickOption(option);
                        }}
                        onMouseEnter={() => setHighlightedIndex(index)}
                        className={cn(
                          "team-mention-option",
                          index === activeHighlight && "is-highlighted",
                        )}
                      >
                        {option.kind === "all" ? (
                          <span className="inline-flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-foreground">
                            <Users size={14} />
                          </span>
                        ) : option.bot ? (
                          <SubagentLogo logo={option.bot.logo} name={option.bot.name} size={28} />
                        ) : null}

                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <strong className="truncate text-xs font-medium text-foreground">
                              @{option.label}
                            </strong>
                            {option.isCoordinator && (
                              <span className="inline-flex items-center gap-0.5 rounded bg-amber-500/12 px-1.5 py-0.5 text-[10px] font-medium text-amber-700 dark:text-amber-300">
                                <Crown size={9} />
                                {t("team.coordinator")}
                              </span>
                            )}
                          </div>
                          <p className="truncate text-[11px] text-muted-foreground">{option.subtitle}</p>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p className="px-3 py-2 text-xs text-muted-foreground">{t("team.mentionEmpty")}</p>
                )}

                <div className="mt-1 border-t border-border/70 pt-1">
                  <button
                    type="button"
                    onMouseDown={(event) => {
                      event.preventDefault();
                      setActiveMention(null);
                      onOpenCreateAndAddBot();
                    }}
                    className="team-mention-option text-xs font-medium text-muted-foreground hover:text-foreground"
                  >
                    <Plus size={14} />
                    <span>{t("team.mentionCreateAndAdd")}</span>
                  </button>
                </div>
              </motion.div>
            )}
          </AnimatePresence>

          {/* 顶部上下文条：引用回复 + 已解析的 @成员胶囊 */}
          {(replyTo || parsedMentions.length > 0) && (
            <div className="flex flex-wrap items-center gap-1.5 border-b border-border/60 px-3.5 py-2">
              {replyTo && (
                <div className="flex min-w-0 max-w-full items-center gap-1.5 rounded-lg bg-muted/70 px-2 py-1 text-[11.5px] text-muted-foreground">
                  <CornerUpLeft size={12} className="shrink-0" />
                  <span className="shrink-0 font-medium text-foreground">
                    {t("team.replyingTo", { name: replySenderName || t("team.you") })}:
                  </span>
                  <span className="truncate">{replyTo.content}</span>
                  <button
                    type="button"
                    onClick={onCancelReply}
                    aria-label={t("team.cancelReply")}
                    className="ml-1 shrink-0 rounded p-0.5 hover:bg-background hover:text-foreground"
                  >
                    <X size={11} />
                  </button>
                </div>
              )}

              {parsedMentions.map((mention) => (
                <span
                  key={`${mention.kind}:${mention.targetId}`}
                  className="inline-flex h-6 items-center gap-1 rounded-full border border-indigo-500/25 bg-indigo-500/10 px-2 text-[11.5px] font-medium text-indigo-700 dark:text-indigo-300"
                >
                  <span>@{mention.label}</span>
                  <button
                    type="button"
                    onClick={() => removeMentionChip(mention)}
                    className="rounded-full p-0.5 opacity-70 hover:opacity-100"
                    aria-label={mention.label}
                  >
                    <X size={10} />
                  </button>
                </span>
              ))}
            </div>
          )}

          {/* 主输入区 */}
          <div className="px-3.5 pt-2.5 pb-1">
            <textarea
              ref={textareaRef}
              value={text}
              rows={1}
              onChange={(event) =>
                handleTextChange(event.target.value, event.target.selectionStart ?? event.target.value.length)
              }
              onClick={(event) => {
                const pos = event.currentTarget.selectionStart ?? 0;
                setCaret(pos);
                setActiveMention(detectActiveMention(text, pos));
              }}
              onKeyUp={(event) => {
                if (["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(event.key)) return;
                const pos = event.currentTarget.selectionStart ?? 0;
                setCaret(pos);
                setActiveMention(detectActiveMention(text, pos));
              }}
              onKeyDown={handleKeyDown}
              placeholder={t("team.mentionHint")}
              className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80"
            />
          </div>

          {/* 底部工具条 */}
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={triggerMentionMenu}
                className="inline-flex h-7 items-center gap-1 rounded-full border border-transparent px-2.5 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <AtSign size={13} />
                <span>{t("team.mentionButton")}</span>
              </button>

              <button
                type="button"
                onClick={onOpenServerPicker}
                className={cn(
                  "inline-flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-xs transition-colors",
                  boundServers.length > 0 && group.execution.strategy !== "local-only"
                    ? "border-sky-500/25 bg-sky-500/10 text-sky-700 dark:text-sky-300"
                    : "border-transparent text-muted-foreground hover:bg-accent hover:text-foreground",
                )}
              >
                {boundServers.length > 0 && group.execution.strategy !== "local-only" ? (
                  <>
                    <CodexServerIcon className="size-3.5" />
                    <span>{boundServers.length === 1 ? boundServers[0].name : `${t("servers.title")} (${boundServers.length})`}</span>
                  </>
                ) : (
                  <>
                    <Laptop size={13} />
                    <span>{t("team.env.local")}</span>
                  </>
                )}
              </button>
            </div>

            <button
              type="button"
              disabled={!text.trim()}
              onClick={submit}
              aria-label={t("team.send")}
              className={cn(
                "inline-flex size-8 items-center justify-center rounded-full transition-all",
                text.trim()
                  ? "bg-primary text-primary-foreground hover:opacity-90 active:scale-95"
                  : "bg-muted text-muted-foreground/60 cursor-not-allowed",
              )}
            >
              <ArrowUp size={15} />
            </button>
          </div>
        </div>
      </div>
    );
  },
);
