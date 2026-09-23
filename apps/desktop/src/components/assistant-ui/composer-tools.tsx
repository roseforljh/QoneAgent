import { useMemo, useRef, useState, type FC } from "react";
import { AssistantModalPrimitive, useAuiState } from "@assistant-ui/react";
import { FileTextIcon, Globe2Icon, PlugZapIcon, PlusIcon, SparklesIcon, type LucideIcon } from "lucide-react";
import { useLocale } from "../../localization";
import type { ComposerToolId } from "../../lib/composer-tool-editor";
import "./composer-tools.css";

export type ComposerTool = { id: ComposerToolId; label: string; description: string; icon: LucideIcon };

function getTools(t: ReturnType<typeof useLocale>["t"]): ComposerTool[] {
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

export const ComposerToolsPopover: FC<{ onSelect: (tool: ComposerTool) => void }> = ({ onSelect }) => {
  const { t } = useLocale();
  const tools = useMemo(() => getTools(t), [t]);
  const [open, setOpen] = useState(false);
  const pendingTool = useRef<ComposerTool | null>(null);
  const disabled = useAuiState((s) => s.thread.isDisabled || !!s.composer.dictation?.inputDisabled);

  return (
    <AssistantModalPrimitive.Root unstable_openOnRunStart={false} open={open} onOpenChange={setOpen}>
      <AssistantModalPrimitive.Trigger asChild>
        <button type="button" disabled={disabled} className="q-composer-tools-trigger text-muted-foreground hover:text-foreground size-7 rounded-full" aria-label={t("composer.openTools")} title={t("composer.openTools")}>
          <PlusIcon className="size-4" />
        </button>
      </AssistantModalPrimitive.Trigger>
      <AssistantModalPrimitive.Content side="bottom" align="start" sideOffset={10} collisionPadding={12} dissmissOnInteractOutside className="q-composer-tools-card" aria-label={t("composer.openTools")}
        onCloseAutoFocus={(event) => {
          const tool = pendingTool.current;
          if (!tool) return;
          event.preventDefault();
          pendingTool.current = null;
          onSelect(tool);
        }}
        onKeyDown={(event) => {
          if (event.nativeEvent.isComposing) return;
          if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]'));
          const current = items.indexOf(document.activeElement as HTMLButtonElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (current + (event.key === "ArrowUp" ? -1 : 1) + items.length) % items.length;
          items[next]?.focus();
        }}>
        <div className="q-composer-tools-list" role="menu">
          {tools.map((tool) => {
            const Icon = tool.icon;
            return (
              <button key={tool.id} type="button" role="menuitem" disabled={disabled} className="q-composer-tool-option" data-tool-id={tool.id} onClick={() => { pendingTool.current = tool; setOpen(false); }}>
                <Icon className="q-composer-tool-icon" aria-hidden="true" />
                <span className="q-composer-tool-copy"><strong>{tool.label}</strong><small>{tool.description}</small></span>
              </button>
            );
          })}
        </div>
      </AssistantModalPrimitive.Content>
    </AssistantModalPrimitive.Root>
  );
};
