import { lazy, Suspense, useMemo, useState } from "react";
import { createTwoFilesPatch } from "diff";
import { useStore } from "../../store";
import { useLocale } from "../../localization";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "../ui/dialog";
import { RunFileTree } from "./elements/run-file-tree";
import { collectRunFileChanges, isRunSummaryOwner, type RunFileNode } from "./run-file-changes";

const DiffViewer = lazy(async () => ({ default: (await import("./elements/diff-viewer")).DiffViewer }));

export function RunFileChangesAttachment({ messageId, runId }: { messageId: string; runId?: string }) {
  const messages = useStore((state) => state.messages);
  const calls = useStore((state) => state.toolCalls);
  const status = useStore((state) => state.runs.find((run) => run.id === runId)?.status);
  const activeRunId = useStore((state) => state.activeRunId);
  const owner = isRunSummaryOwner(messageId, runId, messages, status, activeRunId);
  const changes = useMemo(() => owner && runId ? collectRunFileChanges(runId, calls, messages) : undefined, [owner, runId, calls, messages]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const { locale } = useLocale();
  const selected = changes?.nodes.find((file) => file.path === selectedPath);
  // Only changed hunks enter the viewer, so a tiny edit in a large file does
  // not mount/highlight thousands of unchanged rows when the dialog opens.
  const patches = useMemo(() => selected?.presentations.map((presentation) => presentation.patch ?? createTwoFilesPatch(
    selected.path, selected.path, presentation.oldFile?.content ?? "", presentation.newFile?.content ?? "",
  )) ?? [], [selected]);
  if (!changes?.nodes.length) return null;

  return <>
    <RunFileTree key={runId} changes={changes} onSelect={(file: RunFileNode) => setSelectedPath(file.path)} />
    <Dialog open={Boolean(selected)} onOpenChange={(open) => { if (!open) setSelectedPath(undefined); }}>
      <DialogContent className="flex max-h-[85vh] flex-col overflow-hidden sm:max-w-4xl">
        <DialogTitle className="min-w-0 truncate pr-6 text-sm">{selected?.name}</DialogTitle>
        <DialogDescription className="break-all font-mono text-xs">
          {locale === "en" ? "Changes in this run" : "本次任务的文件变更"}{selected ? ` · ${selected.path}` : ""}
        </DialogDescription>
        <div className="min-h-0 overflow-auto rounded-lg">
          <Suspense fallback={<p className="p-3 text-xs text-foreground/50">{locale === "en" ? "Loading diff…" : "正在加载差异…"}</p>}>
            {patches.map((patch, index) => <DiffViewer key={`${selected?.path}-${index}`} patch={patch} size="sm" showStats showIcon />)}
          </Suspense>
        </div>
      </DialogContent>
    </Dialog>
  </>;
}
