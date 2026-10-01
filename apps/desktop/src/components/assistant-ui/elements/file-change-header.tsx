import { CollapsibleTrigger } from "../../ui/collapsible";
import { CodexPenLineIcon, CodexXIcon, CodexClock3Icon } from "../execution-icons";
import { ShimmerLabel } from "./surfaces";
import type { FileChangeKind } from "../file-change-activity-data";
import { ChangeCounts } from "./change-counts";
import { WorkspacePathContextMenu } from "../dock-context-menu";

interface FileChangeHeaderProps {
  label: string;
  name: string;
  path: string;
  menuPath?: string;
  fileRemoved?: boolean;
  open: boolean;
  panelId: string;
  diffLabel: string;
  fileLabel: string;
  running: boolean;
  failed: boolean;
  waiting: boolean;
  showIcon: boolean;
  changeKind?: FileChangeKind;
  stat?: { added: number; removed: number };
  onOpenFile?: () => void;
}

/** Sibling triggers share the disclosure; the source link navigates independently. */
export function FileChangeHeader({ label, name, path, menuPath, fileRemoved, open, panelId, diffLabel, fileLabel, running, failed, waiting, showIcon, changeKind, stat, onOpenFile }: FileChangeHeaderProps) {
  return <div data-slot="file-change-header" className="group/change-counts flex min-w-0 max-w-full items-baseline gap-1.5 py-0.5 text-[13px] text-foreground/60">
    <CollapsibleTrigger aria-expanded={open} aria-controls={panelId} aria-label={diffLabel}
      className="flex shrink-0 items-baseline gap-1.5 rounded-sm hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">
      {showIcon && <CodexPenLineIcon className="size-3.5 shrink-0 self-center opacity-70" aria-hidden="true" />}
      <ShimmerLabel active={running}>{label}</ShimmerLabel>
    </CollapsibleTrigger>
    <WorkspacePathContextMenu path={menuPath ?? path} onOpen={onOpenFile} onReveal={fileRemoved ? false : undefined}>
      {onOpenFile ? <button type="button" data-slot="tool-target-link" title={path} aria-label={fileLabel} onClick={onOpenFile}
        className="min-w-0 truncate rounded-sm font-mono underline decoration-dotted underline-offset-2 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"><ShimmerLabel active={running} className="inline">{name}</ShimmerLabel></button>
        : <ShimmerLabel active={running} tabIndex={0} className="min-w-0 truncate rounded-sm font-mono focus-visible:outline-2 focus-visible:outline-ring" title={path}>{name}</ShimmerLabel>}
    </WorkspacePathContextMenu>
    {stat && <CollapsibleTrigger data-slot="file-change-counts" aria-controls={panelId} aria-expanded={open} aria-label={diffLabel}
      className="shrink-0 rounded-sm focus-visible:outline-2 focus-visible:outline-ring"><ChangeCounts additions={stat.added} deletions={stat.removed} colorOnHover /></CollapsibleTrigger>}
    {!open && changeKind === "created" && stat && stat.added + stat.removed > 0 && <span data-slot="new-file-indicator" className="size-1.5 shrink-0 self-center rounded-full bg-blue-500/70" />}
    {failed && <CodexXIcon className="size-3.5 shrink-0 self-center text-destructive/80" />}
    {waiting && <CodexClock3Icon className="size-3.5 shrink-0 self-center text-amber-500/80" />}
  </div>;
}
