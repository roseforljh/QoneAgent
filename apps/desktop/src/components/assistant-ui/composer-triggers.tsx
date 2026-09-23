import { useEffect, useMemo, type FC } from "react";
import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  unstable_useTriggerPopoverScopeContext,
} from "@assistant-ui/react";
import { useLocale } from "../../localization";
import { ComposerMenuItem } from "./elements/composer";
import { floating } from "./elements/surfaces";
import { ComposerToolRow, getComposerTools, type ComposerTool } from "./composer-tools";

const popoverClass = `${floating} absolute bottom-full start-2 z-50 mb-2 w-[min(30rem,calc(100vw-24px))] max-h-72 overflow-y-auto rounded-2xl p-1.5 shadow-xl`;

const MentionPopoverState: FC<{ onStateChange: (open: boolean, close: () => void) => void }> = ({ onStateChange }) => {
  const resource = unstable_useTriggerPopoverScopeContext();
  useEffect(() => onStateChange(resource.open, resource.close), [onStateChange, resource.close, resource.open]);
  return null;
};

export const ComposerTriggers: FC<{
  onToolSelect: (tool: ComposerTool) => void;
  onMentionStateChange: (open: boolean, close: () => void) => void;
}> = ({ onToolSelect, onMentionStateChange }) => {
  const { t } = useLocale();
  const tools = useMemo(() => getComposerTools(t), [t]);
  const mentions = useMemo(() => tools.map((tool) => ({
    id: tool.id,
    type: "qone-tool",
    label: tool.label,
    description: tool.description,
  })), [tools]);
  const mention = unstable_useMentionAdapter({ items: mentions, includeModelContextTools: false });
  const slash = unstable_useSlashCommandAdapter({ commands: [] });

  return <>
    <ComposerPrimitive.Unstable_TriggerPopover char="@" adapter={mention.adapter} className={popoverClass} aria-label={t("composer.openTools")}>
      <MentionPopoverState onStateChange={onMentionStateChange} />
      <ComposerPrimitive.Unstable_TriggerPopover.Action
        removeOnExecute
        onExecute={(item) => {
          const tool = tools.find((entry) => entry.id === item.id);
          if (!tool) return;
          if (tool.id === "attachment") onToolSelect(tool);
          else setTimeout(() => onToolSelect(tool), 0);
        }}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="flex flex-col gap-0.5">
        {(items) => items.map((item) => {
          const tool = tools.find((entry) => entry.id === item.id);
          return tool && <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} asChild>
            <ComposerMenuItem className="q-composer-tool-option data-[highlighted]:bg-foreground/[0.06]">
              <ComposerToolRow tool={tool} />
            </ComposerMenuItem>
          </ComposerPrimitive.Unstable_TriggerPopoverItem>;
        })}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>

    <ComposerPrimitive.Unstable_TriggerPopover char="/" adapter={slash.adapter} className={`${popoverClass} min-h-10`} aria-label="Slash commands">
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {() => null}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  </>;
};
