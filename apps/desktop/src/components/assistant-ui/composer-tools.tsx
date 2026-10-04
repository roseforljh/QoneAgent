import { type ComponentType, type FC, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { PlugZapIcon } from "lucide-react";
import type { SkillInfo } from "@qone/protocol";
import { SkillIcon } from "../skills/SkillIcon";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import type { ComposerToolId } from "../../lib/composer-tool-editor";
import { CodexDocumentTextIcon, CodexFolderIcon, CodexPlusIcon, CodexTargetIcon, CodexTextSelectIcon } from "../ui/CodexIcon";
import "./composer-tools.css";

type ToolIcon = ComponentType<{ className?: string; "aria-hidden"?: boolean }>;
export type ComposerTool = { id: ComposerToolId | "compact"; label: string; description: string; icon: ToolIcon };

export function getComposerTools(t: ReturnType<typeof useLocale>["t"]): ComposerTool[] {
  return [
    { id: "attachment", label: t("composer.toolAttachment"), description: t("composer.toolAttachmentDescription"), icon: CodexDocumentTextIcon },
    { id: "folder", label: t("composer.toolFolder"), description: t("composer.toolFolderDescription"), icon: CodexFolderIcon },
    { id: "compact", label: t("composer.toolCompact"), description: t("composer.toolCompactDescription"), icon: CodexTextSelectIcon },
    { id: "goal", label: t("composer.toolGoal"), description: t("composer.toolGoalDescription"), icon: CodexTargetIcon },
  ];
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

export const ComposerToolsPopover: FC<{ open: boolean; onToggle: () => void }> = ({ open, onToggle }) => {
  const { t } = useLocale();
  const disabled = useAuiState((s) => s.thread.isDisabled || !!s.composer.dictation?.inputDisabled);

  return (
    <button
      type="button"
      disabled={disabled}
      aria-expanded={open}
      data-state={open ? "open" : "closed"}
      className="q-composer-tools-trigger text-muted-foreground hover:text-foreground size-7 rounded-full"
      aria-label={t("composer.openTools")}
      title={t("composer.openTools")}
      onClick={onToggle}
    >
      <CodexPlusIcon className="size-4" />
    </button>
  );
};
