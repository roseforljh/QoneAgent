import { expect, test } from "bun:test";
import { createTwoFilesPatch } from "diff";
import { collectRunFileChanges, isRunSummaryOwner } from "../src/components/assistant-ui/run-file-changes";
import { toolDiffStats, detectToolPresentation } from "../src/components/assistant-ui/tool-presentation";
import type { ChatMessage, ToolCall } from "../src/store";

function call(id: string, file: string, oldContent: string | null, newContent: string | null, runId = "r1"): ToolCall {
  return { toolCallId: id, runId, toolName: "arbitrary_mutator", status: "success", result: { details: { fileChanges: [{ path: file, oldContent, newContent }] } } };
}

test("A, B, A yields two files and the actual first-to-last diff, not inflated per-tool totals", () => {
  const changes = collectRunFileChanges("r1", [call("1", "A.ts", "old\n", "intermediate\n"), call("2", "B.ts", "b\n", "b\nnew\n"), call("3", "A.ts", "intermediate\n", "final\n")], []);
  expect(changes.nodes.map((node) => node.name)).toEqual(["A.ts", "B.ts"]);
  expect(changes).toMatchObject({ totalAdditions: 2, totalDeletions: 1 });
  expect(changes.nodes[0]?.presentations).toEqual([{ kind: "diff", name: "A.ts", oldFile: { name: "A.ts", content: "old\n" }, newFile: { name: "A.ts", content: "final\n" } }]);
});

test("run IDs isolate the next task, paths deduplicate, and reversal vanishes", () => {
  const calls = [call("1", "C:\\repo\\A.ts", "old\n", "new\n"), call("2", "c:/repo/./A.ts", "new\n", "old\n"), call("3", "B.ts", null, "created\n", "r2")];
  expect(collectRunFileChanges("r1", calls, []).nodes).toHaveLength(0);
  expect(collectRunFileChanges("r2", calls, []).nodes.map((node) => node.path)).toEqual(["B.ts"]);
  expect(collectRunFileChanges("r3", calls, []).nodes).toHaveLength(0);
});

test("overwriting writes, creates and deletes use real baselines including empty files", () => {
  const changes = collectRunFileChanges("r1", [call("1", "existing.ts", "same\nold\n", "same\nnew\n"), call("2", "deleted.ts", "gone\n", null), call("3", "empty.ts", null, "")], []);
  expect(changes.nodes).toHaveLength(3);
  expect(changes).toMatchObject({ totalAdditions: 1, totalDeletions: 2 });
});

test("reads, plain-text patches, failed edits, unexecuted calls and legacy writes do not invent mutations", () => {
  const patch = createTwoFilesPatch("A.ts", "A.ts", "old\n", "new\n");
  const calls: ToolCall[] = [
    { toolCallId: "read", runId: "r1", toolName: "read", status: "success", args: { path: "A.ts" }, result: "new" },
    { toolCallId: "diff", runId: "r1", toolName: "git_diff", status: "success", result: patch },
    { toolCallId: "failed", runId: "r1", toolName: "edit", status: "failed", args: { path: "A.ts", oldText: "old", newText: "new" }, result: "failed" },
    { ...call("running", "A.ts", "old", "new"), status: "running" },
    { toolCallId: "old-write", runId: "r1", toolName: "write", status: "success", args: { path: "A.ts", content: "new" }, result: "ok" },
  ];
  expect(collectRunFileChanges("r1", calls, []).nodes).toHaveLength(0);
});

test("a failed tool that actually committed a write still retains authoritative evidence", () => {
  expect(collectRunFileChanges("r1", [{ ...call("aborted", "A.ts", "old", "new"), status: "failed" }], []).nodes).toHaveLength(1);
});

test("any custom tool may publish multi-file snapshots or patches without name inference", () => {
  const patch = createTwoFilesPatch("B.ts", "B.ts", "old\n", "new\n");
  const changes = collectRunFileChanges("r1", [{ toolCallId: "patch", runId: "r1", toolName: "plugin:custom:replace", status: "success", result: { details: { fileChanges: [{ path: "A.ts", oldContent: null, newContent: "a\n" }, { path: "B.ts", patch }] } } }], []);
  expect(changes.nodes.map((node) => node.name)).toEqual(["A.ts", "B.ts"]);
  expect(changes).toMatchObject({ totalAdditions: 2, totalDeletions: 1 });
});

test("snapshot followed by a patch composes to one run diff", () => {
  const patch = createTwoFilesPatch("A.ts", "A.ts", "middle\n", "final\n");
  const changes = collectRunFileChanges("r1", [call("1", "A.ts", "old\n", "middle\n"), { toolCallId: "2", runId: "r1", toolName: "apply_patch", status: "success", result: { details: { fileChanges: [{ path: "A.ts", patch }] } } }], []);
  expect(changes.nodes[0]).toMatchObject({ additions: 1, deletions: 1 });
  expect(changes.nodes[0]?.presentations[0]?.newFile?.content).toBe("final\n");
});

test("persisted parts across multiple assistant messages restore once, even with truncated tool summaries", () => {
  const evidence = call("1", "A.ts", "old\n", "new\n");
  const messages: ChatMessage[] = [{ id: "activity", role: "assistant", content: "", runId: "r1", parts: [{ type: "tool-call", toolCallId: "1", toolName: evidence.toolName, args: {}, result: evidence.result, messageSequence: 1 }] }, { id: "final", role: "assistant", runId: "r1", content: "Done" }];
  const changes = collectRunFileChanges("r1", [{ ...evidence, result: '{"content":[' }], JSON.parse(JSON.stringify(messages)));
  expect(changes.nodes).toHaveLength(1);
  expect(changes.totalAdditions).toBe(1);
  expect(isRunSummaryOwner("activity", "r1", messages, "completed")).toBe(false);
  expect(isRunSummaryOwner("final", "r1", messages, "completed")).toBe(true);
  expect(isRunSummaryOwner("final", "r1", messages, "completed", "r2")).toBe(true);
  for (const status of ["running", "paused", "failed", "cancelled", undefined]) expect(isRunSummaryOwner("final", "r1", messages, status)).toBe(false);
  expect(isRunSummaryOwner("final", "r1", messages, "completed", "r1")).toBe(false);
  expect(isRunSummaryOwner("streaming", "r1", messages, "completed")).toBe(false);
});

test("line stats agree with Diff Viewer for reordered lines, trailing newlines and patch content resembling headers", () => {
  expect(toolDiffStats({ kind: "diff", oldFile: { content: "a\nb\n" }, newFile: { content: "b\na\n" } })).toMatchObject({ added: 1, removed: 1 });
  expect(toolDiffStats({ kind: "diff", oldFile: { content: "" }, newFile: { content: "a\n" } })).toMatchObject({ added: 1, removed: 0 });
  const patch = createTwoFilesPatch("A.ts", "A.ts", "--old\n", "++new\n");
  expect(toolDiffStats({ kind: "diff", patch })).toMatchObject({ added: 1, removed: 1 });
  const result = call("1", "A.ts", "old", "new").result;
  expect(detectToolPresentation("not_named_edit", result)).toMatchObject({ kind: "diff", oldFile: { content: "old" }, newFile: { content: "new" } });
});
