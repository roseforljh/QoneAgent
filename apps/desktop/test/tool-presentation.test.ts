import { expect, test } from "bun:test";
import { detectToolPresentation, toolPresentationSummary } from "../src/components/assistant-ui/tool-presentation";

const patch = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new";

test("edit uses Pi's structured patch, or its edits when the result was truncated", () => {
  const presentation = detectToolPresentation("edit", {
    content: [{ type: "text", text: "Successfully replaced 1 block(s) in src/app.ts." }],
    details: { patch },
  }, { path: "src/app.ts", edits: [{ oldText: "old", newText: "new" }] });
  expect(presentation).toEqual({ kind: "diff", patch, name: "src/app.ts" });

  expect(detectToolPresentation("edit", "{\"content\":[{\"type\":\"text\"", { path: "a.ts", edits: [{ oldText: "old", newText: "new" }] })).toEqual({
    kind: "diff", oldFile: { content: "old", name: "a.ts" }, newFile: { content: "new", name: "a.ts" }, name: "a.ts",
  });
});

test("write shows the written content as the new file", () => {
  const presentation = detectToolPresentation(
    "write",
    { content: [{ type: "text", text: "Successfully wrote to src/app.ts" }] },
    { path: "src/app.ts", content: "export const ready = true;" },
  );
  expect(presentation).toEqual({
    kind: "diff",
    oldFile: { content: "", name: "src/app.ts" },
    newFile: { content: "export const ready = true;", name: "src/app.ts" },
    name: "src/app.ts",
  });
});

test("read, shell and grep get their dedicated views by tool name", () => {
  expect(detectToolPresentation("read", { content: [{ type: "text", text: "export const ready = true;" }] }, { path: "src/app.ts" }))
    .toEqual({ kind: "file", content: "export const ready = true;", name: "src/app.ts" });
  expect(detectToolPresentation("powershell", { content: [{ type: "text", text: "ok" }] }, { command: "bun test" }))
    .toEqual({ kind: "terminal", command: "bun test", output: "ok" });
  expect(detectToolPresentation("exec", { content: [{ type: "text", text: "ok" }] }, { cmd: "python -c 'print(1)'" }))
    .toEqual({ kind: "terminal", command: "python -c 'print(1)'", output: "ok" });
  const search = detectToolPresentation("grep", { content: [{ type: "text", text: "src/app.ts:12: ready" }] }, { pattern: "ready" });
  expect(search.kind === "search" && search.items[0]).toEqual({ path: "src/app.ts", line: 12, text: "ready" });
});

test("other tools are never guessed into diffs, file writes, searches or terminals", () => {
  expect(detectToolPresentation("mcp:git:diff", { content: [{ type: "text", text: patch }] }).kind).toBe("text");
  expect(detectToolPresentation("mcp:fs:save", { content: [{ type: "text", text: "Successfully saved" }] }, { path: "a.ts", content: "x" }).kind).toBe("text");
  expect(detectToolPresentation("mcp:code:search", { content: [{ type: "text", text: "src/app.ts:12: ready" }] }, { pattern: "ready" }).kind).toBe("text");
  expect(detectToolPresentation("mcp:ci:run", { content: [{ type: "text", text: "ok" }] }, { command: "pnpm test" }).kind).toBe("text");
});

test("image blocks, text and unknown data", () => {
  expect(detectToolPresentation("mcp:img:render", { content: [{ type: "image", data: "aGk=", mimeType: "image/png" }] }))
    .toEqual({ kind: "image", src: "aGk=", mimeType: "image/png" });
  expect(detectToolPresentation("mcp:x:y", "plain result")).toEqual({ kind: "text", text: "plain result" });
  const unknown = detectToolPresentation("mcp:x:y", { value: 1 });
  expect(unknown.kind).toBe("unknown");
  expect(toolPresentationSummary(unknown)).not.toContain("value");
});
