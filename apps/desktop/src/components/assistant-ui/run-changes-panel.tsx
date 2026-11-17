import { lazy, Suspense, useEffect, useRef, useState } from "react";
import { createTwoFilesPatch } from "diff";
import type { RunChangesTarget } from "../../lib/run-changes-navigation";
import type { RunFileChanges } from "./run-file-changes";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { cn } from "../../lib/utils";
import { openWorkspaceFile, resolveFileReferencePath, workspaceRelativeFilePath } from "../../lib/workspace-file-navigation";
import { ChangeCounts } from "./elements/change-counts";
import { MeasuredCollapse } from "./elements/measured-collapse";
import { CodexChevronRightIcon as ChevronRightIcon } from "./execution-icons";
import { CodeContextMenu, WorkspacePathContextMenu } from "./dock-context-menu";

const DiffViewer = lazy(async () => ({ default: (await import("./elements/diff-viewer")).DiffViewer }));

type ChangedFile = RunFileChanges["nodes"][number];

function ChangedFileDiff({ node, workspacePath }: { node: ChangedFile; workspacePath?: string }) {
  const { locale } = useLocale();
  if (!node.presentations.length || !node.additions && !node.deletions) {
    return <p className="px-3 pb-3 text-xs text-foreground/50">{!node.presentations.length
      ? locale === "en" ? "No saved diff content" : "没有已保存的差异内容"
      : locale === "en" ? { created: "Created an empty file", deleted: "Deleted an empty file", edited: "No line changes" }[node.changeKind]
        : { created: "已创建空文件", deleted: "已删除空文件", edited: "无行内容变化" }[node.changeKind]}</p>;
  }
  const relativePath = workspacePath ? workspaceRelativeFilePath(node.path, workspacePath)
    : resolveFileReferencePath(node.path) ? undefined : node.path;
  return <Suspense fallback={<p className="px-3 pb-3 text-xs text-foreground/50">{locale === "en" ? "Loading diff…" : "正在加载差异…"}</p>}>
    <div className="flex flex-col gap-3 px-3 pb-3">
      {node.presentations.map((presentation, index) => (
        <CodeContextMenu key={index} path={resolveFileReferencePath(node.path, workspacePath)} relativePath={relativePath}>
          <div tabIndex={0}>
            <DiffViewer
              patch={presentation.patch ?? createTwoFilesPatch(node.path, node.path, presentation.oldFile?.content ?? "", presentation.newFile?.content ?? "")}
              size="sm" showHeader={node.presentations.length > 1} showStats showIcon />
          </div>
        </CodeContextMenu>
      ))}
    </div>
  </Suspense>;
}

/** Display saved task evidence, even if a source file has since disappeared.
 * Each file expands in place, so a long list scrolls as one review. */
export function RunChangesPanel({ target }: { target: RunChangesTarget }) {
  const { locale } = useLocale();
  const workspace = useStore((state) => {
    const session = state.sessions.find((item) => item.id === target.sessionId);
    return state.workspaces.find((item) => item.id === session?.workspaceId);
  });
  const requested = (next: RunChangesTarget) => next.path ?? next.changes.nodes[0]?.path;
  const [expanded, setExpanded] = useState(() => ({ target, paths: new Set([requested(target)]) }));
  // A newly requested file opens beside whatever the user already expanded.
  if (expanded.target !== target) setExpanded({ target, paths: new Set([...expanded.paths, requested(target)]) });
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const path = requested(target);
    const row = Array.from(scrollRef.current?.querySelectorAll<HTMLElement>("[data-change-path]") ?? [])
      .find((element) => element.dataset.changePath === path);
    row?.scrollIntoView({ block: "start" });
  }, [target]);

  if (!target.changes.nodes.length) return null;
  const toggle = (path: string) => setExpanded((current) => {
    const paths = new Set(current.paths);
    if (!paths.delete(path)) paths.add(path);
    return { ...current, paths };
  });

  return <section data-slot="run-changes-panel" ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto">
    <div className="flex items-center justify-between px-4 pt-3 pb-2 text-xs text-foreground/60">
      <span>{locale === "en" ? `${target.changes.nodes.length} files changed` : `${target.changes.nodes.length} 个文件已变更`}</span>
      <ChangeCounts additions={target.changes.totalAdditions} deletions={target.changes.totalDeletions} />
    </div>
    {target.changes.nodes.map((node) => {
      const absolutePath = resolveFileReferencePath(node.path, workspace?.path);
      const display = (workspace?.path && workspaceRelativeFilePath(node.path, workspace.path)) || node.path;
      const slash = Math.max(display.lastIndexOf("/"), display.lastIndexOf("\\"));
      const open = expanded.paths.has(node.path);
      return (
        <div key={node.path} data-change-path={node.path} className="border-b border-border/40">
          <WorkspacePathContextMenu
            path={absolutePath ?? node.path}
            onReveal={node.changeKind === "deleted" ? false : undefined}
            onOpen={absolutePath && node.changeKind !== "deleted" ? () => openWorkspaceFile({ sessionId: target.sessionId, workspaceId: workspace?.id, path: absolutePath }) : undefined}
          >
            <button type="button" aria-expanded={open} title={node.path} onClick={() => toggle(node.path)}
              className="sticky top-0 z-10 flex w-full min-w-0 items-center gap-2 bg-background px-3 py-1.5 text-start text-xs hover:bg-muted focus-visible:outline-2 focus-visible:outline-ring">
              <ChevronRightIcon className={cn("size-3.5 shrink-0 text-foreground/50 transition-transform duration-200 motion-reduce:transition-none", open && "rotate-90")} />
              <span className="min-w-0 flex-1 truncate font-mono">
                <span className="text-foreground">{display.slice(slash + 1)}</span>
                {slash > 0 && <span className="ms-2 text-foreground/45">{display.slice(0, slash)}</span>}
              </span>
              <ChangeCounts additions={node.additions} deletions={node.deletions} />
            </button>
          </WorkspacePathContextMenu>
          <MeasuredCollapse open={open}>
            <ChangedFileDiff node={node} workspacePath={workspace?.path} />
          </MeasuredCollapse>
        </div>
      );
    })}
  </section>;
}
