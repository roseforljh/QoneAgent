import { expect, test } from "bun:test";
import { detectToolPresentation, toolPresentationSummary } from "../src/components/assistant-ui/tool-presentation";

test("normalizes unified patches without relying on the tool name", () => {
  const presentation = detectToolPresentation({
    content: [{ type: "text", text: "updated" }],
    details: { patch: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new" },
  });
  expect(presentation.kind).toBe("diff");
  expect(presentation.kind === "diff" && presentation.patch).toContain("@@ -1 +1 @@");
});

test("finds a patch in a plain result string or nested content block", () => {
  const patch = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1 +1 @@\n-old\n+new";
  expect(detectToolPresentation(patch).kind).toBe("diff");
  expect(detectToolPresentation({ content: [{ type: "text", text: patch }] }).kind).toBe("diff");
});

test("normalizes before and after content into a diff", () => {
  const presentation = detectToolPresentation({ path: "notes.md", before: "old", after: "new" });
  expect(presentation).toEqual({
    kind: "diff",
    oldFile: { content: "old", name: "notes.md" },
    newFile: { content: "new", name: "notes.md" },
    name: "notes.md",
  });
});

test("treats a successful path and content result as a file change", () => {
  const presentation = detectToolPresentation(
    { content: [{ type: "text", text: "Successfully wrote to src/app.ts" }] },
    { path: "src/app.ts", content: "export const ready = true;" },
  );
  expect(presentation.kind).toBe("diff");
  expect(presentation.kind === "diff" && presentation.newFile?.content).toContain("ready");
});

test("normalizes a path and changed content into a diff", () => {
  const presentation = detectToolPresentation({ path: "src/app.ts", content: "export const ready = true;" });
  expect(presentation).toEqual({
    kind: "diff",
    oldFile: { content: "", name: "src/app.ts" },
    newFile: { content: "export const ready = true;", name: "src/app.ts" },
    name: "src/app.ts",
  });
});

test("keeps a read result as a file view", () => {
  const presentation = detectToolPresentation(
    { content: [{ type: "text", text: "export const ready = true;" }] },
    { path: "src/app.ts" },
  );
  expect(presentation).toEqual({ kind: "file", content: "export const ready = true;", name: "src/app.ts" });
});

test("maps command output, search output, images, text, and unknown data", () => {
  expect(detectToolPresentation({ content: [{ type: "text", text: "ok" }] }, { command: "pnpm test" }).kind).toBe("terminal");
  expect(detectToolPresentation(undefined, { command: "pnpm test" })).toEqual({ kind: "terminal", command: "pnpm test", output: "" });

  const search = detectToolPresentation(
    { content: [{ type: "text", text: "src/app.ts:12: ready" }] },
    { pattern: "ready" },
  );
  expect(search.kind).toBe("search");
  expect(search.kind === "search" && search.items[0]).toEqual({ path: "src/app.ts", line: 12, text: "ready" });

  expect(detectToolPresentation({ content: [{ type: "image", data: "data:image/png;base64,aGk=", mimeType: "image/png" }] }).kind).toBe("image");
  expect(detectToolPresentation("plain result")).toEqual({ kind: "text", text: "plain result" });
  const unknown = detectToolPresentation({ value: 1 });
  expect(unknown.kind).toBe("unknown");
  expect(toolPresentationSummary(unknown)).not.toContain("value");
});
