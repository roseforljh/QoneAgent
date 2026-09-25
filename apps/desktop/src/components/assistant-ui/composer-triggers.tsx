import { useEffect, useMemo, type FC } from "react";
import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  unstable_useTriggerPopoverScopeContext,
  unstable_defaultDirectiveFormatter,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";
import { useLocale } from "../../localization";
import { useStore } from "../../store";
import { ComposerMenuItem } from "./elements/composer";
import { floating } from "./elements/surfaces";
import { ComposerSlashRow, ComposerToolRow, getComposerTools, type ComposerSlashEntry, type ComposerTool } from "./composer-tools";
import { PlugZapIcon, SparklesIcon } from "lucide-react";

const popoverClass = `${floating} absolute bottom-full start-2 z-50 mb-2 w-[min(30rem,calc(100vw-24px))] max-h-72 overflow-y-auto rounded-2xl p-1.5 shadow-xl`;
const slashFormatter = { ...unstable_defaultDirectiveFormatter, serialize: (item: { label: string }) => item.label };

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
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const skills = useStore((state) => state.skills);
  const mcpServers = useStore((state) => state.mcpServers);
  const currentWorkspaceId = useStore((state) => state.currentWorkspaceId);
  const workspacePath = useStore((state) => state.workspaces.find((workspace) => workspace.id === currentWorkspaceId)?.path);
  const tools = useMemo(() => getComposerTools(t), [t]);
  const slashEntries = useMemo<ComposerSlashEntry[]>(() => [
    ...skills.map((skill) => ({ id: `skill:${skill.id}`, label: `/skill:${skill.name}`, description: skill.description, kind: "skill" as const, icon: SparklesIcon })),
    ...mcpServers.map((server) => ({
      id: `mcp:${server.id}`,
      label: `/mcp:${server.name}`,
      description: server.connected ? `${server.toolCount ?? 0} ${t("mcp.tools")}` : t("mcp.disconnectedStatus"),
      kind: "mcp" as const,
      icon: PlugZapIcon,
    })),
  ], [mcpServers, skills, t]);
  const slashCommands = useMemo<Unstable_SlashCommand[]>(() => slashEntries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    execute: () => undefined,
  })), [slashEntries]);
  const mentions = useMemo(() => tools.map((tool) => ({
    id: tool.id,
    type: "qone-tool",
    label: tool.label,
    description: tool.description,
  })), [tools]);
  const mention = unstable_useMentionAdapter({ items: mentions, includeModelContextTools: false });
  const slash = unstable_useSlashCommandAdapter({ commands: slashCommands });

  useEffect(() => {
    if (!connected) return;
    void send({ type: "mcp.list", requestId: crypto.randomUUID() });
    if (workspacePath) void send({ type: "skills.list", requestId: crypto.randomUUID(), cwd: workspacePath });
  }, [connected, send, workspacePath]);

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
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} formatter={slashFormatter} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => items.map((item) => {
          const entry = slashEntries.find((candidate) => candidate.id === item.id);
          return entry && <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} asChild>
            <ComposerMenuItem className="q-composer-tool-option data-[highlighted]:bg-foreground/[0.06]">
              <ComposerSlashRow entry={entry} />
            </ComposerMenuItem>
          </ComposerPrimitive.Unstable_TriggerPopoverItem>;
        })}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>
  </>;
};
