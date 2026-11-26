import { useMemo, type ComponentType, type FC, type ReactNode, type RefObject } from "react";
import { useAuiState } from "@assistant-ui/react";
import { Menu } from "@base-ui/react/menu";
import { PlugZapIcon } from "lucide-react";
import type { SkillInfo } from "@qone/protocol";
import { SkillIcon } from "../skills/SkillIcon";
import { useLocale } from "../../localization";
import { hasDesktopBridge, useStore } from "../../store";
import { useConversationStore } from "../../lib/conversation-context";
import type { ComposerToolId } from "../../lib/composer-tool-editor";
import { CodexDocumentTextIcon, CodexFolderIcon, CodexPlusIcon, CodexServerIcon, CodexTargetIcon, CodexTextSelectIcon } from "../ui/CodexIcon";
import { ComposerMenuItem } from "./elements/composer";
import "./composer-tools.css";

type ToolIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
export type ComposerTool = { id: ComposerToolId | "compact" | "servers"; label: string; description: string; icon: ToolIcon };

export const composerSuggestionsClass = "q-composer-suggestions flex flex-col overflow-hidden rounded-2xl border border-border/60 bg-background text-sm dark:bg-popover";
export const composerSuggestionsListClass = "q-composer-suggestions-list flex min-h-0 flex-1 flex-col overflow-y-auto overscroll-contain p-1";

export function useComposerTools(): ComposerTool[] {
  const { t } = useLocale();
  const canCompact = useConversationStore((state) => {
    const id = state.currentSessionId;
    return !!(state.connected && id && state.selectedModelId && state.messages.length > 0
      && state.messagesLoadingSessionId !== id && !state.running && !state.compactionStatuses[id]);
  });
  const canUseGoal = useConversationStore((state) => state.connected && !!(state.currentWorkspaceId || state.draftWorkspaceId));
  return useMemo(() => ([
    { id: "attachment", label: t("composer.toolAttachment"), description: t("composer.toolAttachmentDescription"), icon: CodexDocumentTextIcon },
    { id: "folder", label: t("composer.toolFolder"), description: t("composer.toolFolderDescription"), icon: CodexFolderIcon },
    { id: "servers", label: t("servers.title"), description: t("composer.toolServersDescription"), icon: CodexServerIcon },
    { id: "compact", label: t("composer.toolCompact"), description: t("composer.toolCompactDescription"), icon: CodexTextSelectIcon },
    { id: "goal", label: t("composer.toolGoal"), description: t("composer.toolGoalDescription"), icon: CodexTargetIcon },
  ] satisfies ComposerTool[]).filter((tool) => (tool.id !== "compact" || canCompact) && (tool.id !== "goal" || canUseGoal)
    && (tool.id !== "folder" || hasDesktopBridge())), [canCompact, canUseGoal, t]);
}

type ComposerSlashBase = {
  id: string;
  label: string;
  description: string;
};
export type ComposerSlashEntry = ComposerSlashBase & (
  | { kind: "skill"; skill: SkillInfo }
  | { kind: "mcp"; serverId: string; icon: ToolIcon }
  | { kind: "action"; tool: ComposerTool; icon: ToolIcon }
);

export const ComposerSlashRow: FC<{ entry: ComposerSlashEntry }> = ({ entry }) => {
  const Icon = entry.kind === "skill" ? undefined : entry.icon;
  return <>
    {entry.kind === "skill"
      ? <SkillIcon skill={entry.skill} className="q-composer-tool-icon size-4 shrink-0" />
      : Icon && <Icon data-tool-id={entry.kind} className="q-composer-tool-icon size-4 shrink-0" aria-hidden={true} />}
    <span className="q-composer-tool-copy">
      <strong>{entry.label}</strong>
      <small>{entry.description}</small>
    </span>
  </>;
};

export const ComposerToolChip: FC<{ directiveId: string; directiveType: string; label: string }> = ({ directiveId, directiveType, label }) => {
  const mcpId = directiveType === "qone-command" && directiveId.startsWith("mcp:") ? directiveId.slice(4) : undefined;
  let serverId: string | undefined;
  if (mcpId) {
    try { serverId = decodeURIComponent(mcpId); }
    catch { serverId = mcpId; }
  }
  const serverName = useStore((state) => serverId ? state.mcpServers.find((server) => server.id === serverId)?.name : undefined);
  const isSkill = directiveType === "qone-command" && directiveId.startsWith("skill:");
  const skillName = isSkill ? directiveId.slice(6) : undefined;
  const skill = useStore((state) => skillName ? state.skills.find((item) => item.name === skillName) : undefined);
  const kind = serverId ? "mcp" : isSkill ? "skill" : directiveId.startsWith("qone-") ? directiveId.slice(5) : directiveId;
  const displayLabel = serverId ? serverName ?? serverId : isSkill ? directiveId.slice(6) : label;
  return <span className="q-composer-tool-chip" data-tool-id={kind} data-directive-type={directiveType} aria-label={displayLabel} title={displayLabel}>
    {isSkill ? <SkillIcon skill={skill} className="q-composer-tool-chip-icon" /> : serverId && <PlugZapIcon className="q-composer-tool-chip-icon" aria-hidden="true" />}
    <span className="q-composer-tool-chip-label">{displayLabel}</span>
  </span>;
};

export const ComposerToolRow: FC<{ tool: ComposerTool; children?: ReactNode }> = ({ tool, children }) => {
  const Icon = tool.icon;
  return <>
    <Icon data-tool-id={tool.id} className="q-composer-tool-icon size-4 shrink-0" aria-hidden={true} />
    <span className="q-composer-tool-copy">
      <strong>{tool.label}</strong>
      <small>{tool.description}</small>
    </span>
    {children}
  </>;
};

export const ComposerToolsPopover: FC<{
  anchor: RefObject<HTMLDivElement | null>;
  tools: readonly ComposerTool[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onToolSelect: (tool: ComposerTool) => void;
}> = ({ anchor, tools, open, onOpenChange, onToolSelect }) => {
  const { t } = useLocale();
  const disabled = useAuiState((s) => s.thread.isDisabled || !!s.composer.dictation?.inputDisabled);
  const label = t("composer.openTools");

  return <Menu.Root open={open} onOpenChange={onOpenChange} modal={false}>
    <Menu.Trigger type="button" disabled={disabled} aria-label={label} title={label}
      className="q-composer-tools-trigger text-muted-foreground hover:text-foreground size-7 rounded-full">
      <CodexPlusIcon className="size-4" />
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner anchor={anchor} side="top" sideOffset={8} className="z-50 w-(--anchor-width)">
        <Menu.Popup aria-label={label} className={`${composerSuggestionsClass} max-h-[min(15rem,50dvh,var(--available-height))]`}>
          <div className={composerSuggestionsListClass}>
            {tools.map((tool) => <Menu.Item key={tool.id} label={tool.label} nativeButton
              render={<ComposerMenuItem className="q-composer-tool-option" />} onClick={() => onToolSelect(tool)}>
              <ComposerToolRow tool={tool} />
            </Menu.Item>)}
          </div>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>;
};
