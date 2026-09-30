import { expect, test } from "bun:test";
import { runChangesTab, type RunChangesTarget } from "../src/lib/run-changes-navigation";
import { collectToolFileChanges } from "../src/components/assistant-ui/run-file-changes";
import type { RunFileChanges } from "../src/components/assistant-ui/run-file-changes";

const changes: RunFileChanges = {
  nodes: ["A.ts", "B.ts"].map((path) => ({ path, name: path, depth: 0, kind: "file", changeKind: "edited", additions: 1, deletions: 1, presentations: [{ kind: "diff", name: path, oldFile: { name: path, content: "before\n" }, newFile: { name: path, content: "after\n" } }] })),
  totalAdditions: 2, totalDeletions: 2,
};
const target: RunChangesTarget = { sessionId: "session", runId: "run", changes, path: "B.ts" };

test("review retains saved evidence and selects the requested file without a workspace", () => {
  const tab = runChangesTab([], target, () => "new-tab");
  expect(tab.changesTarget?.path).toBe("B.ts");
  expect(tab.changesTarget?.changes).toBe(changes);
  expect(tab.workspaceId).toBeUndefined();
});

test("same run reuses its tab; other runs and sessions have independent reviews", () => {
  const tab = runChangesTab([], target, () => "first");
  expect(runChangesTab([tab], { ...target, path: "A.ts" }, () => "unused").id).toBe("first");
  expect(runChangesTab([tab], { ...target, runId: "other" }, () => "second").id).toBe("second");
  expect(runChangesTab([tab], { ...target, sessionId: "other" }, () => "third").id).toBe("third");
});

test("summary click preserves selection and invalid paths fall back to saved files", () => {
  const tab = runChangesTab([], target, () => "first");
  expect(runChangesTab([tab], { ...target, path: undefined }, () => "unused").changesTarget?.path).toBe("B.ts");
  expect(runChangesTab([], { ...target, path: "outside" }, () => "new").changesTarget?.path).toBe("A.ts");
});

test("activity group statistics compose repeated edits and vanish after reversal", () => {
  const edit = (oldContent: string, newContent: string) => ({ toolName: "custom", status: "success", result: { details: { fileChanges: [{ path: "A.ts", oldContent, newContent }] } } });
  const summary = collectToolFileChanges([edit("a\n", "b\n"), edit("b\n", "c\n")]);
  expect(summary.totalAdditions).toBe(1);
  expect(summary.totalDeletions).toBe(1);
  expect(collectToolFileChanges([edit("a\n", "b\n"), edit("b\n", "a\n")]).nodes).toEqual([]);
});
