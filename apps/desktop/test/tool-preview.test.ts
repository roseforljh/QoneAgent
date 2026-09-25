import { expect, test } from "bun:test";
import { detectToolPreview } from "../src/components/assistant-ui/tool-preview";
import { toolActivity } from "../src/components/assistant-ui/tool-call-display";

test("partial arguments preview available changes without inventing old file contents", () => {
  expect(detectToolPreview({ path: "a.ts" })).toBeUndefined();
  expect(detectToolPreview({ path: "a.ts", oldText: "old" })).toBeUndefined();
  expect(detectToolPreview({ path: "a.ts", oldText: "old", newText: "n" })).toMatchObject({
    kind: "diff", oldFile: { content: "old" }, newFile: { content: "n" },
  });
  expect(detectToolPreview({ path: "a.ts", content: "new content" })).toEqual({ kind: "file", name: "a.ts", content: "new content" });
  expect(detectToolPreview({ command: "bun test" })).toMatchObject({ kind: "terminal", command: "bun test", output: "" });
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
