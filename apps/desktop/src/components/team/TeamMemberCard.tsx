import { AtSign, Crown, MessageCircle, Pencil } from "lucide-react";
import { useId, useRef, useState, type ReactElement } from "react";
import { ContextMenu, Popover } from "radix-ui";
import { useLocale } from "../../localization";
import type { TeamBot, TeamBotPresence } from "../../lib/team/types";
import { cn } from "../../lib/utils";
import { Button } from "../ui/Button";
import { BotModelChip } from "./BotModelChip";
import { TeamAvatar } from "./TeamAvatar";
import "../assistant-ui/sidebar-menu.css";

export interface TeamMemberActions {
  onDirectChat?: (bot: TeamBot) => void;
  onMentionBot?: (bot: TeamBot) => void;
  onEditBot: (bot: TeamBot) => void;
}

interface TeamMemberCardProps {
  bot: TeamBot;
  presence?: TeamBotPresence;
  coordinator?: boolean;
  canMention?: boolean;
  actions: TeamMemberActions;
  children: ReactElement;
}

export function TeamMemberCard({ bot, presence, coordinator, canMention = true, actions, children }: TeamMemberCardProps) {
  const { t } = useLocale();
  const titleId = useId();
  const [open, setOpen] = useState(false);
  const switching = useRef(false);
  const pendingContextAction = useRef<(() => void) | null>(null);
  const activate = (action?: (bot: TeamBot) => void, movesFocus = true) => {
    if (!action) return;
    switching.current = movesFocus;
    setOpen(false);
    action(bot);
  };
  const mentionAction = canMention ? actions.onMentionBot : undefined;
  return (
    <ContextMenu.Root>
      <Popover.Root open={open} onOpenChange={(next) => { if (next) switching.current = false; setOpen(next); }}>
        <ContextMenu.Trigger asChild>
          <Popover.Trigger asChild>{children}</Popover.Trigger>
        </ContextMenu.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={8}
            collisionPadding={12}
            aria-labelledby={titleId}
            className="team-popover-panel team-member-popover"
            onCloseAutoFocus={(event) => { if (switching.current) event.preventDefault(); }}
          >
          <div className="flex items-start gap-3">
            <TeamAvatar bot={{ ...bot, name: "" }} size={48} />
            <div className="min-w-0 space-y-1">
              <div className="flex flex-wrap items-center gap-1.5">
                <h2 id={titleId} className="min-w-0 break-words text-sm font-semibold">{bot.name}</h2>
                {coordinator && <Crown size={13} className="shrink-0 text-amber-500" aria-label={t("team.coordinator")} />}
              </div>
              {bot.roleTitle && <div className="break-words text-xs text-muted-foreground">{bot.roleTitle}</div>}
              {(presence || bot.modelId) && (
                <div className="flex flex-wrap items-center gap-2 text-[11px] text-muted-foreground">
                  {presence && (
                    <span className="inline-flex items-center gap-1.5">
                      <span className={cn("team-presence-dot", `is-${presence}`)} aria-hidden="true" />
                      {t(`team.presence.${presence}`)}
                    </span>
                  )}
                  <BotModelChip bot={bot} onClick={() => activate(actions.onEditBot)} />
                </div>
              )}
            </div>
          </div>
          {bot.description && <p className="mt-3 line-clamp-3 break-words text-xs leading-relaxed text-muted-foreground">{bot.description}</p>}
          <div className="mt-3 grid grid-cols-2 gap-1.5 border-t border-border/70 pt-3">
            {([
              [actions.onDirectChat, MessageCircle, "team.member.direct"],
              [canMention ? actions.onMentionBot : undefined, AtSign, "team.mentionButton"],
              [actions.onEditBot, Pencil, "team.member.edit"],
            ] as const).filter(([action]) => action).map(([action, Icon, label]) => (
              <Button
                key={label}
                size="sm"
                variant={label === "team.member.direct" ? "default" : "outline"}
                className="min-w-0 gap-1.5 text-xs"
                onClick={() => activate(action)}
              >
                <Icon className="size-3.5" />
                {t(label)}
              </Button>
            ))}
          </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
      <ContextMenu.Portal>
        <ContextMenu.Content
          className="q-sidebar-menu"
          collisionPadding={8}
          onCloseAutoFocus={(event) => {
            const action = pendingContextAction.current;
            if (!action) return;
            pendingContextAction.current = null;
            event.preventDefault();
            action();
          }}
        >
          {mentionAction && (
            <ContextMenu.Item
              className="q-sidebar-menu-item"
              onSelect={() => { pendingContextAction.current = () => mentionAction(bot); }}
            >
              <AtSign className="size-3.5" />
              <span>@{bot.name}</span>
            </ContextMenu.Item>
          )}
          {actions.onDirectChat && (
            <ContextMenu.Item
              className="q-sidebar-menu-item"
              onSelect={() => { pendingContextAction.current = () => actions.onDirectChat?.(bot); }}
            >
              <MessageCircle className="size-3.5" />
              <span>{t("team.member.direct")}</span>
            </ContextMenu.Item>
          )}
          <ContextMenu.Item
            className="q-sidebar-menu-item"
            onSelect={() => { pendingContextAction.current = () => actions.onEditBot(bot); }}
          >
            <Pencil className="size-3.5" />
            <span>{t("team.member.edit")}</span>
          </ContextMenu.Item>
        </ContextMenu.Content>
      </ContextMenu.Portal>
    </ContextMenu.Root>
  );
}
