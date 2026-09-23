import { expect, test } from "bun:test";
import { AnyFileAttachmentAdapter } from "../src/lib/file-attachment-adapter";

test("generic file adapter accepts and serializes non-text files", async () => {
  const adapter = new AnyFileAttachmentAdapter();
  const file = new File([new Uint8Array([0, 1, 2, 3])], "archive.zip", { type: "application/zip" });
  const pending = await adapter.add({ file });
  const complete = await adapter.send(pending);

  expect(adapter.accept).toBe("*");
  expect(complete.type).toBe("file");
  expect(complete.name).toBe("archive.zip");
  expect(complete.content).toEqual([{
    type: "file",
    filename: "archive.zip",
    mimeType: "application/zip",
    data: "data:application/zip;base64,AAECAw==",
  }]);
});
