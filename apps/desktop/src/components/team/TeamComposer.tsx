import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type ClipboardEvent,
  type KeyboardEvent,
} from "react";
import { AnimatePresence, motion } from "motion/react";
import {
  ArrowUp,
  CornerUpLeft,
  Crown,
  Laptop,
  Plus,
  Users,
  X,
} from "lucide-react";
import type { MessageAttachmentInfo, ServerInfo } from "@qone/protocol";
import { confirmDestructiveAction } from "../../lib/confirm-action";
import { localizeError } from "../../lib/error-localization";
import { serializeFilesToAttachments } from "../../lib/message-attachments";
import { pickNativeAttachmentFiles, useNativeFileDrop } from "../../lib/native-file-drop";
import {
  applyMentionSelection,
  detectActiveMention,
  extractMentionsFromText,
  moveSelectedMentions,
  type ActiveMentionQuery,
  type SelectedMention,
} from "../../lib/team/mentions";
import type { TeamBot, TeamGroup, TeamMentionRef, TeamMessage } from "../../lib/team/types";
import { useLocale } from "../../localization";
import { hasDesktopBridge, useStore } from "../../store";
import { cn } from "../../lib/utils";
import { CodexPlusIcon, CodexServerIcon } from "../ui/CodexIcon";
import { ModelPicker } from "../assistant-ui/model-picker";
import { RunOptionsPopover } from "../assistant-ui/run-options-popover";
import { TeamAttachmentStrip } from "./TeamAttachmentStrip";
import { TeamAvatar } from "./TeamAvatar";

export interface TeamComposerHandle {
  insertMention: (bot: TeamBot) => void;
  setDraft: (value: string) => void;
  focus: () => void;
}

export interface TeamComposerDraft {
  text: string;
  mentions: SelectedMention[];
  attachments?: MessageAttachmentInfo[];
}

interface TeamComposerProps {
  group: TeamGroup;
  members: readonly TeamBot[];
  servers: readonly ServerInfo[];
  drafts: Map<string, TeamComposerDraft>;
  replyTo?: TeamMessage;
  replySenderName?: string;
  onCancelReply: () => void;
  onSend: (content: string, mentions: TeamMentionRef[], attachments?: MessageAttachmentInfo[]) => void;
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
      drafts,
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
    const composerBoxRef = useRef<HTMLDivElement>(null);
    const textareaRef = useRef<HTMLTextAreaElement>(null);
    const fileInputRef = useRef<HTMLInputElement>(null);
    const [draft, setComposerDraft] = useState<TeamComposerDraft>(() => drafts.get(group.id) ?? { text: "", mentions: [], attachments: [] });
    const { text, mentions: selectedMentions } = draft;
    const attachments = draft.attachments ?? [];
    const attachmentsRef = useRef(attachments);
    attachmentsRef.current = attachments;
    const setText = useCallback((value: string, mention?: SelectedMention, edit?: { start: number; end: number }) => {
      setComposerDraft((previous) => {
        const mentions = moveSelectedMentions(previous.text, value, previous.mentions, edit);
        if (mention) mentions.push(mention);
        return { ...previous, text: value, mentions };
      });
    }, []);
    const isDirect = Boolean(group.directBotId);
    const [caret, setCaret] = useState(0);
    const [activeMention, setActiveMention] = useState<ActiveMentionQuery | null>(null);
    const [highlightedIndex, setHighlightedIndex] = useState(0);
    const [dropHovering, setDropHovering] = useState(false);

    const addFiles = useCallback(async (files: File[]) => {
      if (!files.length) return;
      try {
        const next = await serializeFilesToAttachments(files, attachmentsRef.current);
        setComposerDraft((previous) => ({ ...previous, attachments: next }));
      } catch (error) {
        useStore.setState({ lastError: localizeError(error) });
      }
    }, []);

    useNativeFileDrop(composerBoxRef, addFiles, setDropHovering);

    const handlePickFiles = () => {
      if (hasDesktopBridge()) {
        void pickNativeAttachmentFiles().then(addFiles).catch((error) => {
          useStore.setState({ lastError: localizeError(error) });
        });
      } else {
        fileInputRef.current?.click();
      }
    };

    const handleFileInputChange = (event: ChangeEvent<HTMLInputElement>) => {
      const files = Array.from(event.target.files ?? []);
      event.target.value = "";
      void addFiles(files);
    };

    const handlePaste = (event: ClipboardEvent<HTMLTextAreaElement>) => {
      const files = Array.from(event.clipboardData?.items ?? [])
        .filter((item) => item.kind === "file")
        .map((item) => item.getAsFile())
        .filter((file): file is File => Boolean(file));
      if (!files.length) return;
      event.preventDefault();
      void addFiles(files);
    };

    const removeAttachment = (index: number) => {
      const target = attachmentsRef.current[index];
      if (!target) return;
      void confirmDestructiveAction(t("team.attachmentRemoveConfirm", { name: target.name })).then((confirmed) => {
        if (!confirmed) return;
        setComposerDraft((previous) => ({
          ...previous,
          attachments: (previous.attachments ?? []).filter((_, idx) => idx !== index),
        }));
      });
    };

    const allLabel = t("team.mentionAll");
    const allLabels = useMemo(() => [...new Set([allLabel, "全体成员", "全体", "Everyone", "all"])], [allLabel]);

    const parsedMentions = useMemo(
      () => isDirect ? [] : extractMentionsFromText(text, members, allLabels, selectedMentions),
      [text, members, allLabels, selectedMentions, isDirect],
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

    useEffect(() => {
      if (draft.text || (draft.attachments?.length ?? 0) > 0) drafts.set(group.id, draft);
      else drafts.delete(group.id);
    }, [drafts, group.id, draft]);

    useEffect(() => { resizeTextarea(); }, [resizeTextarea]);

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
      (ref: TeamMentionRef) => {
        const token = `@${ref.label} `;
        const currentCaret = textareaRef.current?.selectionStart ?? caret;
        const before = text.slice(0, currentCaret);
        const after = text.slice(currentCaret);
        const spacer = before.length > 0 && !/\s$/.test(before) ? " " : "";
        const nextText = `${before}${spacer}${token}${after}`;
        const nextCaret = before.length + spacer.length + token.length;
        setText(nextText, { start: before.length + spacer.length, ref }, { start: currentCaret, end: currentCaret });
        setActiveMention(null);
        setHighlightedIndex(0);
        focusAt(nextCaret);
      },
      [caret, focusAt, setText, text],
    );

    useImperativeHandle(
      ref,
      () => ({
        insertMention: (bot) => insertMentionAtCaret({ kind: "bot", targetId: bot.id, label: bot.name }),
        setDraft: (value: string) => {
          setComposerDraft((previous) => ({ ...previous, text: value, mentions: [] }));
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
      setActiveMention(isDirect ? null : detectActiveMention(nextValue, nextCaret));
      setHighlightedIndex(0);
      resizeTextarea();
    };

    const pickOption = (option: MentionOption) => {
      const ref: TeamMentionRef = { kind: option.kind, targetId: option.key, label: option.label };
      if (!activeMention) {
        insertMentionAtCaret(ref);
        return;
      }
      const { nextText, nextCaret } = applyMentionSelection(text, activeMention, option.label);
      setText(nextText, { start: activeMention.start, ref }, activeMention);
      setActiveMention(null);
      focusAt(nextCaret);
    };

    const canSend = Boolean(text.trim() || attachments.length > 0);

    const submit = () => {
      const trimmed = text.trim();
      if (!trimmed && attachments.length === 0) return;
      onSend(trimmed, parsedMentions, attachments.length > 0 ? attachments : undefined);
      setComposerDraft({ text: "", mentions: [], attachments: [] });
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
        <div
          ref={composerBoxRef}
          className={cn("team-composer-box", dropHovering && "is-drop-hover")}
        >
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="sr-only"
            tabIndex={-1}
            onChange={handleFileInputChange}
          />
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
                          <TeamAvatar bot={option.bot} size={28} />
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

          {/* 顶部上下文条：引用回复 + 待发附件 */}
          {(replyTo || attachments.length > 0) && (
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

              <TeamAttachmentStrip
                attachments={attachments}
                workspaceId={group.execution.workspaceId}
                onRemove={removeAttachment}
              />
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
                setActiveMention(isDirect ? null : detectActiveMention(text, pos));
              }}
              onKeyUp={(event) => {
                if (["ArrowDown", "ArrowUp", "Enter", "Escape", "Tab"].includes(event.key)) return;
                const pos = event.currentTarget.selectionStart ?? 0;
                setCaret(pos);
                setActiveMention(isDirect ? null : detectActiveMention(text, pos));
              }}
              onKeyDown={handleKeyDown}
              onPaste={handlePaste}
              placeholder={t(isDirect ? "team.member.directPlaceholder" : "team.mentionHint")}
              className="w-full resize-none bg-transparent text-[13.5px] leading-relaxed text-foreground outline-none placeholder:text-muted-foreground/80"
            />
          </div>

          {/* 底部工具条：与主页面对齐（左：+ 直接选文件、权限模式、服务器；右：模型选择、发送） */}
          <div className="flex items-center justify-between gap-2 px-3 pb-2.5">
            <div className="q-composer-actions-leading flex min-w-0 items-center gap-1">
              <button
                type="button"
                onClick={handlePickFiles}
                title={t("attachment.add")}
                aria-label={t("attachment.add")}
                className="q-composer-tools-trigger inline-flex size-7 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                <CodexPlusIcon className="size-4" />
              </button>

              <RunOptionsPopover />

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

            <div className="q-composer-actions-trailing flex min-w-0 items-center justify-end gap-1.5">
              <ModelPicker />
              <button
                type="button"
                disabled={!canSend}
                onClick={submit}
                aria-label={t("team.send")}
                className={cn(
                  "inline-flex size-8 shrink-0 items-center justify-center rounded-full transition-all",
                  canSend
                    ? "bg-primary text-primary-foreground hover:opacity-90 active:scale-95"
                    : "bg-muted text-muted-foreground/60 cursor-not-allowed",
                )}
              >
                <ArrowUp size={15} />
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  },
);
