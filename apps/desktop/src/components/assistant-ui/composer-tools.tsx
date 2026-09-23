import { type FC, type ReactNode } from "react";
import { useAuiState } from "@assistant-ui/react";
import { FileTextIcon, Globe2Icon, PlugZapIcon, PlusIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { useLocale } from "../../localization";
import type { ComposerToolId } from "../../lib/composer-tool-editor";
import "./composer-tools.css";

export type ComposerTool = { id: ComposerToolId; label: string; description: string; icon: LucideIcon };

export function getComposerTools(t: ReturnType<typeof useLocale>["t"]): ComposerTool[] {
  return [
    { id: "attachment", label: t("composer.toolAttachment"), description: t("composer.toolAttachmentDescription"), icon: FileTextIcon },
    { id: "skills", label: t("composer.toolSkills"), description: t("composer.toolSkillsDescription"), icon: SparklesIcon },
    { id: "mcp", label: "MCP", description: t("composer.toolMcpDescription"), icon: PlugZapIcon },
    { id: "web-search", label: t("composer.toolWebSearch"), description: t("composer.toolWebSearchDescription"), icon: Globe2Icon },
  ];
}

export const ComposerToolChip: FC<{ directiveId: string; directiveType: string; label: string }> = ({ directiveId, directiveType, label }) => (
  <span className="q-composer-tool-chip" data-tool-id={directiveId.replace("qone-", "")} data-directive-type={directiveType} aria-label={label}>
    {label}
  </span>
);

export const ComposerToolRow: FC<{ tool: ComposerTool; children?: ReactNode }> = ({ tool, children }) => {
  const Icon = tool.icon;
  return <>
    <Icon data-tool-id={tool.id} className="q-composer-tool-icon size-4 shrink-0" aria-hidden="true" />
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
      <PlusIcon className="size-4" />
    </button>
  );
};
