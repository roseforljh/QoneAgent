import { expect, test } from "bun:test";
import { readInlineFilePreview } from "../src/lib/message-file-preview";

test("inline markdown attachments become right dock preview data", async () => {
  const result = await readInlineFilePreview("notes.md", {
    data: "data:text/markdown;base64,IyBOb3Rlcw==",
    mimeType: "text/markdown",
  });
  expect(result.file).toMatchObject({ kind: "markdown", mimeType: "text/markdown", content: "# Notes" });
  expect(result.blob.size).toBe(7);
});
