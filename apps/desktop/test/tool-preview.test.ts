import { expect, test } from "bun:test";
import { detectToolPreview } from "../src/components/assistant-ui/tool-preview";
import { toolActivity } from "../src/components/assistant-ui/tool-call-display";

test("partial arguments preview available changes without inventing old file contents", () => {
  expect(detectToolPreview("edit", { path: "a.ts" })).toBeUndefined();
  expect(detectToolPreview("edit", { path: "a.ts", edits: [{ oldText: "old" }] })).toBeUndefined();
  expect(detectToolPreview("edit", { path: "a.ts", edits: [{ oldText: "old", newText: "n" }] })).toMatchObject({
    kind: "diff", oldFile: { content: "old" }, newFile: { content: "n" },
  });
  expect(detectToolPreview("edit", { path: "a.ts", oldText: "old", newText: "n" })).toMatchObject({ kind: "diff" });
  expect(detectToolPreview("write", { path: "a.ts", content: "new content" })).toEqual({ kind: "file", name: "a.ts", content: "new content" });
  expect(detectToolPreview("powershell", { command: "bun test" })).toEqual({ kind: "terminal", command: "bun test", output: "" });
  expect(detectToolPreview("exec", { cmd: "python -c 'print(1)'" })).toEqual({ kind: "terminal", command: "python -c 'print(1)'", output: "" });
  expect(detectToolPreview("mcp:fs:save", { path: "a.ts", content: "x" })).toBeUndefined();
});

test("tool lifecycle distinguishes generation, queue, execution, approval, and completion", () => {
  expect(toolActivity({}, undefined, false, true)).toBe("generating");
  expect(toolActivity({}, undefined, true, true)).toBe("queued");
  expect(toolActivity({}, { status: "running" }, true, true)).toBe("running");
  expect(toolActivity({}, { status: "waiting" }, true, true)).toBe("waiting");
  expect(toolActivity({ result: "partial" }, { status: "running" }, false, true)).toBe("running");
  expect(toolActivity({ result: "done" }, { status: "success" }, false, true)).toBe("success");
  expect(toolActivity({ isError: true }, undefined, true, true)).toBe("failed");
  expect(toolActivity({ status: { type: "incomplete" } }, undefined, false, false)).toBe("failed");
});
