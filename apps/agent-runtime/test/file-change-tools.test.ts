import { expect, test } from "bun:test";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createFileChangeTools } from "../src/file-change-tools";
import { ApprovalQueue, withPermission } from "../src/permissions";
import { toolFileChanges, applyAssistantToolEvent, persistedToolResult } from "@qone/protocol";
import { openDb, closeDb, SessionRepo, RunRepo, ToolCallRepo } from "@qone/database";

const execute = (tool: ReturnType<typeof createFileChangeTools>[number], params: unknown) => tool.execute(crypto.randomUUID(), params as never, undefined, undefined, undefined);

test("SDK operations capture overwrite, create and exact edit baselines without altering Pi", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qone-run-changes-"));
  try {
    const [edit, write] = createFileChangeTools(root);
    const file = path.join(root, "a.ts");
    await writeFile(file, "\ufeffsame\r\nold\r\n");
    const edited = await execute(edit!, { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] });
    expect(toolFileChanges(edited)).toEqual([{ path: await realpath(file), oldContent: "\ufeffsame\r\nold\r\n", newContent: "\ufeffsame\r\nnew\r\n" }]);
    expect((edited.details as { patch?: string }).patch).toContain("+new");
    const overwritten = await execute(write!, { path: file, content: "final\n" });
    expect(toolFileChanges(overwritten)[0]).toMatchObject({ oldContent: "\ufeffsame\r\nnew\r\n", newContent: "final\n" });
    const created = await execute(write!, { path: "nested/new.ts", content: "created\n" });
    expect(toolFileChanges(created)[0]).toMatchObject({ oldContent: null, newContent: "created\n" });
    await expect(execute(edit!, { path: file, edits: [{ oldText: "missing", newText: "oops" }] })).rejects.toThrow();
    expect(await readFile(file, "utf8")).toBe("final\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("parallel edits take baselines inside Pi's shared mutation queue", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qone-run-parallel-"));
  try {
    const [edit] = createFileChangeTools(root);
    await writeFile(path.join(root, "a.ts"), "first\nsecond\n");
    const [one, two] = await Promise.all([
      execute(edit!, { path: "a.ts", edits: [{ oldText: "first", newText: "FIRST" }] }),
      execute(edit!, { path: "a.ts", edits: [{ oldText: "second", newText: "SECOND" }] }),
    ]);
    const first = toolFileChanges(one)[0]!;
    const second = toolFileChanges(two)[0]!;
    expect(first).toMatchObject({ oldContent: "first\nsecond\n", newContent: "FIRST\nsecond\n" });
    expect(second).toMatchObject({ oldContent: "FIRST\nsecond\n", newContent: "FIRST\nSECOND\n" });
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("permission denial does not execute file operations or produce evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "qone-run-denied-"));
  try {
    const [, write] = createFileChangeTools(root);
    const tool = withPermission(write!, { queue: new ApprovalQueue(), workspacePath: root, mode: () => "full", rules: { get: () => "deny" }, emitApproval: () => { throw Error("approval"); } });
    const result = await execute(tool, { path: "a.ts", content: "no" });
    expect(toolFileChanges(result)).toEqual([]);
    await expect(readFile(path.join(root, "a.ts"))).rejects.toThrow();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("large mutation evidence survives both persisted tool calls and message parts", () => {
  const db = openDb(":memory:");
  try {
    const session = new SessionRepo(db).create("changes");
    const run = new RunRepo(db).create(session.id);
    const repo = new ToolCallRepo(db);
    const row = repo.start(run.id, "arbitrary_patch_tool", {}, "one");
    const result = { content: [{ type: "text", text: "x".repeat(30_000) }], details: { fileChanges: [{ path: "a.ts", oldContent: "before\n".repeat(10_000), newContent: "after\n".repeat(10_000) }] } };
    repo.finish(row.id, "success", result);
    expect(toolFileChanges(repo.listByRun(run.id)[0]!.resultSummary)).toEqual(result.details.fileChanges);
    const parts = applyAssistantToolEvent([{ type: "tool-call", toolCallId: "one", toolName: "arbitrary_patch_tool", args: {}, messageSequence: 1 }], "tool.completed", { toolCallId: "one", result });
    expect(parts[0]?.type === "tool-call" && toolFileChanges(parts[0].result)).toEqual(result.details.fileChanges);
    expect(persistedToolResult(result)).toEqual(persistedToolResult(persistedToolResult(result)));
  } finally { closeDb(db); }
});
