import { useId, useState, type ReactElement } from "react";
import { CodexChevronRightIcon, CodexPenLineIcon } from "../execution-icons";
import { CodexIcon } from "../../ui/CodexIcon";
import chevronDown from "../../../assets/codex-icons/chevron-down-md-light-16.svg";
import { Collapsible, CollapsibleTrigger } from "../../ui/collapsible";
import { useLocale } from "../../../localization";
import { resolveFileReferencePath } from "../../../lib/workspace-file-navigation";
import type { RunFileChanges, RunFileNode } from "../run-file-changes";
import { WorkspacePathContextMenu } from "../dock-context-menu";
import { ChangeCounts } from "./change-counts";
import { FileChangePath } from "./file-change-path";
import { MeasuredCollapse } from "./measured-collapse";

// Codex 26.928 completion cards show this many files before explicit expansion.
const COLLAPSED_FILE_COUNT = 3;

/** Completed turn resource card. Every review target opens saved changes. */
export function RunFileChangesCard({ changes, onReview, onOpenFile, displayPath, workspacePath }: {
  changes: RunFileChanges;
  onReview?: (path?: string) => void;
  onOpenFile?: (file: RunFileNode) => boolean;
  displayPath?: (file: RunFileNode) => string;
  workspacePath?: string;
}) {
  const { locale } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const panelId = useId();
  if (!changes.nodes.length) return null;
  const single = changes.nodes.length === 1 ? changes.nodes[0] : undefined;
  const title = locale === "en" ? single ? `Edited ${single.name}` : `Edited ${changes.nodes.length} files`
    : single ? `已编辑 ${single.name}` : `已编辑 ${changes.nodes.length} 个文件`;
  const reviewLabel = locale === "en" ? "View changes" : "查看变更";
  const remainingCount = changes.nodes.length - COLLAPSED_FILE_COUNT;
  const expandLabel = expanded ? locale === "en" ? "Collapse files" : "收起文件"
    : locale === "en" ? `Show ${remainingCount} more ${remainingCount === 1 ? "file" : "files"}` : `再显示 ${remainingCount} 个文件`;
  const fileMenu = (node: RunFileNode, child: ReactElement) => {
    const path = resolveFileReferencePath(node.path, workspacePath);
    return <WorkspacePathContextMenu key={node.path} path={path ?? node.path}
      onReview={onReview ? () => onReview(node.path) : undefined}
      onOpen={path && node.changeKind !== "deleted" && onOpenFile ? () => { onOpenFile(node); } : undefined}
      onReveal={node.changeKind === "deleted" ? false : undefined}>{child}</WorkspacePathContextMenu>;
  };
  const fileRow = (node: RunFileNode) => fileMenu(node, <button type="button" data-slot="run-file-change" title={node.path}
    aria-label={locale === "en" ? `View changes: ${node.path}` : `查看变更：${node.path}`} disabled={!onReview}
    onClick={(event) => {
      if (node.changeKind !== "deleted" && (event.metaKey || event.ctrlKey) && onOpenFile?.(node)) return;
      onReview?.(node.path);
    }}
    className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-start transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
    <FileChangePath path={displayPath?.(node) ?? node.path} />
    <ChangeCounts additions={node.additions} deletions={node.deletions} />
  </button>);
  const header = <button type="button" aria-label={locale === "en" ? "View changed files" : "查看变更文件"} onClick={() => onReview?.(single?.path)} disabled={!onReview}
    className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-start focus-visible:outline-2 focus-visible:outline-ring">
    <CodexPenLineIcon className="size-4 shrink-0 text-foreground/60" aria-hidden="true" />
    <span className="min-w-0 flex-1">
      <span className="block truncate text-[13px] font-medium">{title}</span>
      <span className="group-hover/changes:hidden group-focus-within/changes:hidden"><ChangeCounts additions={changes.totalAdditions} deletions={changes.totalDeletions} /></span>
      <span className="hidden items-center gap-1 text-xs text-foreground/60 group-hover/changes:inline-flex group-focus-within/changes:inline-flex">{reviewLabel}<CodexChevronRightIcon className="size-3" /></span>
    </span>
  </button>;
  return <Collapsible open={expanded} onOpenChange={setExpanded} asChild>
    <section data-slot="run-file-changes" className="mt-3 w-full min-w-0 max-w-2xl overflow-hidden rounded-xl border border-border/60 bg-muted/15">
      <div className="group/changes flex min-w-0 items-center gap-3 px-3 py-2.5">
        {single ? fileMenu(single, header) : header}
        <button type="button" onClick={() => onReview?.(single?.path)} disabled={!onReview}
          className="shrink-0 rounded-md border border-border/60 px-2 py-1 text-xs text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{reviewLabel}</button>
      </div>
      {!single && <div className="border-t border-border/50 py-1">
        {changes.nodes.slice(0, COLLAPSED_FILE_COUNT).map(fileRow)}
        {remainingCount > 0 && <MeasuredCollapse id={panelId} open={expanded}>
          {changes.nodes.slice(COLLAPSED_FILE_COUNT).map(fileRow)}
        </MeasuredCollapse>}
      </div>}
      {remainingCount > 0 && <CollapsibleTrigger data-slot="run-file-changes-toggle" aria-controls={panelId}
        className="flex min-h-9 w-full items-center gap-2 border-t border-border/50 px-3 py-2 text-start text-xs text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span>{expandLabel}</span>
        <CodexIcon src={chevronDown} className={`size-3 shrink-0 transition-transform duration-200 motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`} />
      </CollapsibleTrigger>}
    </section>
  </Collapsible>;
}
