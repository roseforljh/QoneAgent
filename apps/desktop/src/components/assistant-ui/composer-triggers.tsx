import { useEffect, useMemo, type FC } from "react";
import {
  ComposerPrimitive,
  unstable_useMentionAdapter,
  unstable_useSlashCommandAdapter,
  unstable_useTriggerPopoverScopeContext,
  type Unstable_SlashCommand,
} from "@assistant-ui/react";
import { useLocale } from "../../localization";
import { hasTauriBridge, useStore } from "../../store";
import { ComposerMenuItem } from "./elements/composer";
import { ComposerSlashRow, ComposerToolRow, getComposerTools, type ComposerSlashEntry, type ComposerTool } from "./composer-tools";
import type { ComposerCommand } from "../../lib/composer-tool-editor";
import { PlugZapIcon, SparklesIcon } from "lucide-react";

// Codex's composer suggestions span their composer anchor and sit 8px above it.
const popoverClass = "q-composer-suggestions absolute inset-x-0 bottom-full z-50 mb-2 flex flex-col overflow-y-auto rounded-2xl border border-border/60 bg-background p-1 text-sm dark:bg-popover";
const MentionPopoverState: FC<{ onStateChange: (open: boolean, close: () => void) => void }> = ({ onStateChange }) => {
  const resource = unstable_useTriggerPopoverScopeContext();
  useEffect(() => onStateChange(resource.open, resource.close), [onStateChange, resource.close, resource.open]);
  return null;
};

export const ComposerTriggers: FC<{
  onToolSelect: (tool: ComposerTool) => void;
  onCommandSelect: (command: ComposerCommand) => void;
  onMentionStateChange: (open: boolean, close: () => void) => void;
  onSlashStateChange: (open: boolean) => void;
}> = ({ onToolSelect, onCommandSelect, onMentionStateChange, onSlashStateChange }) => {
  const { t } = useLocale();
  const send = useStore((state) => state.send);
  const connected = useStore((state) => state.connected);
  const skills = useStore((state) => state.skills);
  const mcpServers = useStore((state) => state.mcpServers);
  const currentWorkspaceId = useStore((state) => state.currentWorkspaceId);
  const draftWorkspaceId = useStore((state) => state.draftWorkspaceId);
  const currentSessionId = useStore((state) => state.currentSessionId);
  const selectedModelId = useStore((state) => state.selectedModelId);
  const compacting = useStore((state) => Boolean(state.currentSessionId && state.compactionStatuses[state.currentSessionId]));
  const messageCount = useStore((state) => state.messages.length);
  const messagesLoadingSessionId = useStore((state) => state.messagesLoadingSessionId);
  const running = useStore((state) => state.running);
  const workspaceId = currentSessionId ? currentWorkspaceId : draftWorkspaceId ?? currentWorkspaceId;
  const workspacePath = useStore((state) => state.workspaces.find((workspace) => workspace.id === workspaceId)?.path);
  const canCompact = connected && !!currentSessionId && !!selectedModelId && messageCount > 0 && messagesLoadingSessionId !== currentSessionId && !running
    && !compacting;
  const canUseGoal = connected && !!(currentWorkspaceId || draftWorkspaceId);
  const tools = useMemo(() => getComposerTools(t).filter((tool) =>
    (tool.id !== "compact" || canCompact) && (tool.id !== "goal" || canUseGoal) && (tool.id !== "folder" || hasTauriBridge()),
  ), [canCompact, canUseGoal, t]);
  const compactTool = tools.find((tool) => tool.id === "compact");
  const slashEntries = useMemo<ComposerSlashEntry[]>(() => [
    ...(connected && workspacePath ? skills.map((skill) => ({ id: `skill:${skill.id}`, label: `/skill:${skill.name}`, description: skill.description, kind: "skill" as const, name: skill.name, icon: SparklesIcon })) : []),
    ...(connected && workspacePath ? mcpServers.filter((server) => server.connected && (server.toolCount ?? 0) > 0).map((server) => ({
      id: `mcp:${server.id}`, label: server.name, description: `${server.toolCount} ${t("mcp.tools")}`,
      kind: "mcp" as const, serverId: server.id, icon: PlugZapIcon,
    })) : []),
    ...(compactTool ? [{ id: "compact", label: `/compact`, description: compactTool.description, kind: "action" as const, tool: compactTool, icon: compactTool.icon }] : []),
  ], [compactTool, connected, mcpServers, skills, t, workspacePath]);
  const slashCommands = useMemo<Unstable_SlashCommand[]>(() => slashEntries.map((entry) => ({
    id: entry.id,
    label: entry.label,
    description: entry.description,
    execute: () => {
      // The trigger removes the typed command before editing or compacting.
      setTimeout(() => {
        if (entry.kind === "skill") onCommandSelect({ kind: "skill", name: entry.name });
        else if (entry.kind === "mcp") onCommandSelect({ kind: "mcp", serverId: entry.serverId });
        else onToolSelect(entry.tool);
      }, 0);
    },
  })), [onCommandSelect, onToolSelect, slashEntries]);
  const mentions = useMemo(() => tools.map((tool) => ({
    id: tool.id,
    type: "qone-tool",
    label: tool.label,
    description: tool.description,
  })), [tools]);
  const mention = unstable_useMentionAdapter({ items: mentions, includeModelContextTools: false });
  const slash = unstable_useSlashCommandAdapter({ commands: slashCommands, removeOnExecute: true });

  useEffect(() => {
    if (!connected) return;
    if (workspacePath) void send({ type: "skills.list", requestId: crypto.randomUUID(), cwd: workspacePath });
  }, [connected, send, workspacePath]);

  useEffect(() => {
    if (slashEntries.length === 0) onSlashStateChange(false);
  }, [onSlashStateChange, slashEntries.length]);

  return <>
    <ComposerPrimitive.Unstable_TriggerPopover char="@" adapter={mention.adapter} className={`${popoverClass} max-h-[min(15rem,50dvh)]`} aria-label={t("composer.openTools")}>
      <MentionPopoverState onStateChange={onMentionStateChange} />
      <ComposerPrimitive.Unstable_TriggerPopover.Action
        removeOnExecute
        onExecute={(item) => {
          const tool = tools.find((entry) => entry.id === item.id);
          if (!tool) return;
          if (tool.id === "attachment" || tool.id === "folder") onToolSelect(tool);
          else setTimeout(() => onToolSelect(tool), 0);
        }}
      />
      <ComposerPrimitive.Unstable_TriggerPopoverItems className="flex flex-col">
        {(items) => items.map((item) => {
          const tool = tools.find((entry) => entry.id === item.id);
          return tool && <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} asChild>
            <ComposerMenuItem className="q-composer-tool-option">
              <ComposerToolRow tool={tool} />
            </ComposerMenuItem>
          </ComposerPrimitive.Unstable_TriggerPopoverItem>;
        })}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>

    {slashEntries.length > 0 && <ComposerPrimitive.Unstable_TriggerPopover char="/" adapter={slash.adapter} className={`${popoverClass} max-h-[min(24rem,50dvh)]`} aria-label={t("composer.slashCommands")}>
      <MentionPopoverState onStateChange={onSlashStateChange} />
      <ComposerPrimitive.Unstable_TriggerPopover.Action {...slash.action} />
      <ComposerPrimitive.Unstable_TriggerPopoverItems>
        {(items) => items.map((item) => {
          const entry = slashEntries.find((candidate) => candidate.id === item.id);
          return entry && <ComposerPrimitive.Unstable_TriggerPopoverItem key={item.id} item={item} asChild>
            <ComposerMenuItem className="q-composer-tool-option">
              <ComposerSlashRow entry={entry} />
            </ComposerMenuItem>
          </ComposerPrimitive.Unstable_TriggerPopoverItem>;
        })}
      </ComposerPrimitive.Unstable_TriggerPopoverItems>
    </ComposerPrimitive.Unstable_TriggerPopover>}
  </>;
};
