import { lazy, Suspense, useState } from "react";
import { createTwoFilesPatch } from "diff";
import type { RunChangesTarget } from "../../lib/run-changes-navigation";
import { useLocale } from "../../localization";
import { ChangeCounts } from "./elements/change-counts";

const DiffViewer = lazy(async () => ({ default: (await import("./elements/diff-viewer")).DiffViewer }));

/** Display saved task evidence, even if a source file has since disappeared. */
export function RunChangesPanel({ target }: { target: RunChangesTarget }) {
  const { locale } = useLocale();
  const [selection, setSelection] = useState({ target, path: target.path });
  if (selection.target !== target) setSelection({ target, path: target.path });
  const requestedPath = selection.target === target ? selection.path : target.path;
  const selected = target.changes.nodes.find((node) => node.path === requestedPath) ?? target.changes.nodes[0];
  if (!selected) return null;
  return <section data-slot="run-changes-panel" className="flex min-h-0 flex-1 flex-col">
    <div className="max-h-48 shrink-0 overflow-y-auto border-b border-border/50 p-2">
      <div className="mb-1 flex items-center justify-between px-2 text-xs text-foreground/60">
        <span>{locale === "en" ? `${target.changes.nodes.length} files changed` : `${target.changes.nodes.length} 个文件已变更`}</span>
        <ChangeCounts additions={target.changes.totalAdditions} deletions={target.changes.totalDeletions} />
      </div>
      {target.changes.nodes.map((node) => <button type="button" key={node.path} aria-pressed={node.path === selected.path} title={node.path}
        onClick={() => setSelection({ target, path: node.path })}
        className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-start text-xs hover:bg-muted/50 aria-pressed:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
        <span className="min-w-0 flex-1 truncate font-mono">{node.path}</span><ChangeCounts additions={node.additions} deletions={node.deletions} />
      </button>)}
    </div>
    <div className="min-h-0 flex-1 overflow-auto p-3">
      {!selected.presentations.length || !selected.additions && !selected.deletions
        ? <p className="text-xs text-foreground/50">{!selected.presentations.length
          ? locale === "en" ? "No saved diff content" : "没有已保存的差异内容"
          : locale === "en" ? { created: "Created an empty file", deleted: "Deleted an empty file", edited: "No line changes" }[selected.changeKind]
            : { created: "已创建空文件", deleted: "已删除空文件", edited: "无行内容变化" }[selected.changeKind]}</p>
        : <>
      <Suspense fallback={<p className="text-xs text-foreground/50">{locale === "en" ? "Loading diff…" : "正在加载差异…"}</p>}>
        <div className="flex flex-col gap-3">
          {selected.presentations.map((presentation, index) => <DiffViewer key={`${selected.path}-${index}`}
            patch={presentation.patch ?? createTwoFilesPatch(selected.path, selected.path, presentation.oldFile?.content ?? "", presentation.newFile?.content ?? "")}
            size="sm" showStats showIcon />)}
        </div>
      </Suspense>
      </>}
    </div>
  </section>;
}
