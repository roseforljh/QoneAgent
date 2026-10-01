import type { RunFileChanges } from "../components/assistant-ui/run-file-changes";
import type { DockTab } from "./dock-state";

export interface RunChangesTarget {
  sessionId: string;
  runId: string;
  changes: RunFileChanges;
  path?: string;
}

export const OPEN_RUN_CHANGES_EVENT = "qone-open-run-changes";

export function openRunChanges(target: RunChangesTarget): void {
  window.dispatchEvent(new CustomEvent(OPEN_RUN_CHANGES_EVENT, { detail: target }));
}

/** Reopen the same task's review, preserving a valid file selection. */
export function runChangesTab(tabs: readonly DockTab[], target: RunChangesTarget, newId: () => string): DockTab {
  const existing = tabs.find((tab) => tab.view === "changes" && tab.changesTarget?.sessionId === target.sessionId && tab.changesTarget.runId === target.runId);
  const path = [target.path, existing?.changesTarget?.path].find((path) => path && target.changes.nodes.some((node) => node.path === path)) ?? target.changes.nodes[0]?.path;
  return { id: existing?.id ?? newId(), view: "changes", changesTarget: { ...target, path } };
}
