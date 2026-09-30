import { CodexChevronRightIcon, CodexPenLineIcon } from "../execution-icons";
import { useLocale } from "../../../localization";
import type { RunFileChanges, RunFileNode } from "../run-file-changes";
import { ChangeCounts } from "./change-counts";

/** Completed turn resource card. Every review target opens saved changes. */
export function RunFileChangesCard({ changes, onReview, onOpenFile, displayPath }: {
  changes: RunFileChanges;
  onReview?: (path?: string) => void;
  onOpenFile?: (file: RunFileNode) => boolean;
  displayPath?: (file: RunFileNode) => string;
}) {
  const { locale } = useLocale();
  if (!changes.nodes.length) return null;
  const single = changes.nodes.length === 1 ? changes.nodes[0] : undefined;
  const title = locale === "en" ? single ? `Edited ${single.name}` : `Edited ${changes.nodes.length} files`
    : single ? `已编辑 ${single.name}` : `已编辑 ${changes.nodes.length} 个文件`;
  const reviewLabel = locale === "en" ? "View changes" : "查看变更";
  return <section data-slot="run-file-changes" className="mt-3 w-full min-w-0 max-w-2xl overflow-hidden rounded-xl border border-border/60 bg-muted/15">
    <div className="group/changes flex min-w-0 items-center gap-3 px-3 py-2.5">
      <button type="button" aria-label={locale === "en" ? "View changed files" : "查看变更文件"} onClick={() => onReview?.(single?.path)} disabled={!onReview}
        className="flex min-w-0 flex-1 items-center gap-2.5 rounded-sm text-start focus-visible:outline-2 focus-visible:outline-ring">
        <CodexPenLineIcon className="size-4 shrink-0 text-foreground/60" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-[13px] font-medium">{title}</span>
          <span className="group-hover/changes:hidden group-focus-within/changes:hidden"><ChangeCounts additions={changes.totalAdditions} deletions={changes.totalDeletions} /></span>
          <span className="hidden items-center gap-1 text-xs text-foreground/60 group-hover/changes:inline-flex group-focus-within/changes:inline-flex">{reviewLabel}<CodexChevronRightIcon className="size-3" /></span>
        </span>
      </button>
      <button type="button" onClick={() => onReview?.(single?.path)} disabled={!onReview}
        className="shrink-0 rounded-md border border-border/60 px-2 py-1 text-xs text-foreground/70 transition-colors hover:bg-foreground/5 hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring">{reviewLabel}</button>
    </div>
    {!single && <div className="max-h-72 overflow-y-auto border-t border-border/50 py-1">
      {changes.nodes.map((node) => <button type="button" key={node.path} data-slot="run-file-change" title={node.path}
        aria-label={locale === "en" ? `View changes: ${node.path}` : `查看变更：${node.path}`} disabled={!onReview}
        onClick={(event) => {
          if ((event.metaKey || event.ctrlKey) && onOpenFile?.(node)) return;
          onReview?.(node.path);
        }}
        className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-start transition-colors hover:bg-foreground/5 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring">
        <span className="min-w-0 flex-1 truncate font-mono text-xs text-foreground/70">{displayPath?.(node) ?? node.path}</span>
        <ChangeCounts additions={node.additions} deletions={node.deletions} />
      </button>)}
    </div>}
  </section>;
}
