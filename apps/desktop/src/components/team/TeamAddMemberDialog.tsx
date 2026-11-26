import { useEffect, useMemo, useState } from "react";
import { Dialog } from "radix-ui";
import { Check, Pencil, Plus, Search, Trash2, X } from "lucide-react";
import type { TeamBot, TeamGroup } from "../../lib/team/types";
import { acquireNativeOverlayLock } from "../../lib/dock-browser-session";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { BotModelChip } from "./BotModelChip";
import { TeamAvatar } from "./TeamAvatar";

interface TeamAddMemberDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  group: TeamGroup;
  allBots: readonly TeamBot[];
  onAddMembers: (botIds: string[]) => void;
  onOpenCreateBot: () => void;
  onEditBot: (bot: TeamBot) => void;
  onDeleteBot: (bot: TeamBot) => void;
}

/** 拉入成员对话框：支持搜索、多选批量拉入、编辑/删除自定义机器人，以及直接新建机器人加入当前群。 */
export function TeamAddMemberDialog({
  open,
  onOpenChange,
  group,
  allBots,
  onAddMembers,
  onOpenCreateBot,
  onEditBot,
  onDeleteBot,
}: TeamAddMemberDialogProps) {
  const { t } = useLocale();
  const [query, setQuery] = useState("");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);

  useEffect(() => (open ? acquireNativeOverlayLock() : undefined), [open]);

  useEffect(() => {
    if (!open) return;
    setQuery("");
    setSelectedIds([]);
  }, [open]);

  const memberSet = useMemo(() => new Set(group.memberBotIds), [group.memberBotIds]);
  const normalized = query.trim().toLocaleLowerCase();

  const sortedBots = useMemo(() => {
    const filtered = normalized
      ? allBots.filter((bot) =>
          `${bot.name} ${bot.roleTitle} ${bot.description} ${bot.capabilities.join(" ")}`
            .toLocaleLowerCase()
            .includes(normalized),
        )
      : [...allBots];
    // 未加入当前群的成员排在前面，已在当前群的成员置后展示便于管理。
    return filtered.sort((left, right) => Number(memberSet.has(left.id)) - Number(memberSet.has(right.id)));
  }, [allBots, memberSet, normalized]);

  const toggleSelect = (botId: string) => {
    if (memberSet.has(botId)) return;
    setSelectedIds((prev) => (prev.includes(botId) ? prev.filter((id) => id !== botId) : [...prev, botId]));
  };

  const handleConfirm = () => {
    if (!selectedIds.length) return;
    onAddMembers(selectedIds);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="nested-dialog-overlay" />
        <Dialog.Content
          className="nested-dialog is-wide"
          onEscapeKeyDown={(event) => event.stopPropagation()}
          aria-describedby={undefined}
        >
          <header>
            <div>
              <Dialog.Title asChild>
                <h2>{t("team.addMember")}</h2>
              </Dialog.Title>
              <p>{group.name}</p>
            </div>
            <Dialog.Close className="nested-dialog-close" aria-label={t("common.close")}>
              <X size={16} />
            </Dialog.Close>
          </header>

          <div className="nested-dialog-body">
            <label className="relative flex items-center">
              <Search size={13} className="pointer-events-none absolute left-3 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t("team.dialog.searchMembers")}
                aria-label={t("team.dialog.searchMembers")}
                className="h-9 w-full rounded-xl border border-border bg-background pr-3 pl-8 text-xs text-foreground outline-none placeholder:text-muted-foreground focus:border-foreground/40"
              />
            </label>

            <div className="flex max-h-[340px] flex-col gap-1.5 overflow-y-auto pr-0.5">
              {sortedBots.map((bot) => {
                const inGroup = memberSet.has(bot.id);
                const checked = selectedIds.includes(bot.id);
                return (
                  <div
                    key={bot.id}
                    className={cn(
                      "flex items-center gap-2.5 rounded-xl border px-3 py-2 transition-colors",
                      inGroup
                        ? "border-border/50 bg-muted/30 opacity-75"
                        : checked
                          ? "border-foreground/45 bg-foreground/[0.04]"
                          : "border-border/75 bg-background hover:border-foreground/25",
                    )}
                  >
                    <button
                      type="button"
                      disabled={inGroup}
                      onClick={() => toggleSelect(bot.id)}
                      className={cn(
                        "flex min-w-0 flex-1 items-center gap-2.5 text-left",
                        inGroup ? "cursor-default" : "cursor-pointer",
                      )}
                    >
                      <span
                        className={cn(
                          "inline-flex size-4.5 shrink-0 items-center justify-center rounded-md border transition-colors",
                          inGroup || checked
                            ? "border-primary bg-primary text-primary-foreground"
                            : "border-border bg-background",
                        )}
                        aria-hidden="true"
                      >
                        {(inGroup || checked) && <Check size={11} />}
                      </span>
                      <TeamAvatar bot={{ ...bot, name: "" }} size={34} />
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-1.5">
                          <strong className="truncate text-xs font-semibold text-foreground">{bot.name}</strong>
                          {bot.source === "custom" && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t("team.source.custom")}
                            </span>
                          )}
                          {inGroup && (
                            <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground">
                              {t("team.inCurrentGroup")}
                            </span>
                          )}
                        </div>
                        <div className="mt-0.5 flex min-w-0 items-center gap-1.5">
                          <span className="truncate text-[11px] text-muted-foreground">
                            {bot.roleTitle || bot.description}
                          </span>
                          <BotModelChip
                            bot={bot}
                            onClick={() => {
                              onOpenChange(false);
                              onEditBot(bot);
                            }}
                          />
                        </div>
                      </div>
                    </button>

                    <div className="flex shrink-0 items-center gap-0.5">
                      <button
                        type="button"
                        onClick={() => {
                          onOpenChange(false);
                          onEditBot(bot);
                        }}
                        title={t("team.editBot")}
                        aria-label={t("team.editBot")}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
                      >
                        <Pencil size={12} />
                      </button>
                      {bot.source === "custom" && (
                        <button
                          type="button"
                          onClick={() => onDeleteBot(bot)}
                          title={t("team.deleteBot")}
                          aria-label={t("team.deleteBot")}
                          className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-destructive"
                        >
                          <Trash2 size={12} />
                        </button>
                      )}
                    </div>
                  </div>
                );
              })}

              {sortedBots.length === 0 && (
                <p className="py-8 text-center text-xs text-muted-foreground">{t("team.emptyBotsTitle")}</p>
              )}
            </div>
          </div>

          <footer className="is-split">
            <button
              type="button"
              className="team-dialog-btn"
              onClick={() => {
                onOpenChange(false);
                onOpenCreateBot();
              }}
            >
              <Plus size={13} />
              <span>{t("team.newBot")}</span>
            </button>
            <div className="flex items-center gap-2.5">
              <button type="button" className="team-dialog-btn" onClick={() => onOpenChange(false)}>
                {t("common.cancel")}
              </button>
              <button
                type="button"
                className="team-dialog-btn is-primary"
                disabled={selectedIds.length === 0}
                onClick={handleConfirm}
              >
                {selectedIds.length > 0 ? `${t("team.addMember")} (${selectedIds.length})` : t("team.addMember")}
              </button>
            </div>
          </footer>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
