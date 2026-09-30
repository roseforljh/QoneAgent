import { useId, useState } from "react";
import { CodexChevronRightIcon, CodexPenLineIcon } from "../execution-icons";
import { CodexIcon } from "../../ui/CodexIcon";
import document from "../../../assets/codex-icons/document-light-16.svg";
import { MeasuredCollapse } from "./measured-collapse";
import { useLocale } from "../../../localization";
import type { RunFileChanges, RunFileNode } from "../run-file-changes";

function ChangeCounts({ additions, deletions }: { additions: number; deletions: number }) {
  return <span className="shrink-0 font-mono text-[11px] tabular-nums">
    <span className="text-emerald-600/80 dark:text-emerald-400/80">+{additions}</span>{" "}
    <span className="text-red-600/80 dark:text-red-400/80">−{deletions}</span>
  </span>;
}

/** Compact adaptation of assistant-ui Elements File Tree: flat path/name/
 * depth/kind nodes and run totals, with disclosure rather than a large tree.
 * https://www.assistant-ui.com/elements/file-tree
 */
export function RunFileTree({ changes, onSelect }: { changes: RunFileChanges; onSelect: (file: RunFileNode) => void }) {
  const { locale } = useLocale();
  const [open, setOpen] = useState(false);
  const id = useId();
  if (!changes.nodes.length) return null;
  return <div data-slot="run-file-changes" className="mt-3 w-full min-w-0 max-w-2xl text-xs">
    <button type="button" aria-expanded={open} aria-controls={id} onClick={() => setOpen((value) => !value)}
      className="flex max-w-full items-center gap-2 rounded-lg px-2 py-1.5 text-foreground/55 transition-colors hover:bg-foreground/[0.035] hover:text-foreground/75 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
      <CodexPenLineIcon className="size-3.5 shrink-0 opacity-60" aria-hidden="true" />
      <span className="truncate">{locale === "en" ? `${changes.nodes.length} ${changes.nodes.length === 1 ? "file" : "files"} changed` : `${changes.nodes.length} 个文件已更改`}</span>
      <ChangeCounts additions={changes.totalAdditions} deletions={changes.totalDeletions} />
      <CodexChevronRightIcon className={`size-3 shrink-0 opacity-50 transition-transform duration-200 motion-reduce:transition-none ${open ? "rotate-90" : ""}`} aria-hidden="true" />
    </button>
    <MeasuredCollapse id={id} open={open}>
      <ul data-slot="run-file-list" className="mt-1 max-h-60 overflow-y-auto overscroll-contain rounded-lg border border-foreground/[0.06] bg-foreground/[0.015] p-1">
        {changes.nodes.map((node) => <li key={node.path}>
          <button type="button" title={node.path} onClick={() => onSelect(node)}
            className="flex w-full min-w-0 items-center gap-2 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-foreground/[0.04] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            <CodexIcon src={document} className="size-3.5 shrink-0 text-foreground/35" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground/70">{node.name}</span>
            <ChangeCounts additions={node.additions} deletions={node.deletions} />
          </button>
        </li>)}
      </ul>
    </MeasuredCollapse>
  </div>;
}
