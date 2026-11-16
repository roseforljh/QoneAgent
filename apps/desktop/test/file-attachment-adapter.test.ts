import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import { AnyFileAttachmentAdapter, QoneAttachmentAdapter } from "../src/lib/file-attachment-adapter";
import { serializeMessageAttachments } from "../src/lib/message-attachments";
import { createNativeAttachmentFile, type NativeAttachmentFile } from "../src/lib/native-attachment-file";
import { DIRECTORY_MIME_TYPE } from "@qone/protocol";

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

test("native image and file adapters never read their empty metadata Files", async () => {
  const adapter = new QoneAttachmentAdapter();
  const image = createNativeAttachmentFile("plot.png", "image/png", "C:\\Media\\plot.png", 10_000);
  const archive = createNativeAttachmentFile("archive.zip", "application/zip", "C:\\Media\\archive.zip", 100_000_000);
  const sentImage = await adapter.send(await adapter.add({ file: image }));
  const sentArchive = await adapter.send(await adapter.add({ file: archive }));
  expect(sentImage.type).toBe("image");
  expect(sentImage.file).toBe(image);
  expect(sentImage.content).toEqual([{ type: "image", image: "", filename: "plot.png" }]);
  expect(sentArchive.file).toBe(archive);
  expect(sentArchive.content).toEqual([{ type: "file", filename: "archive.zip", mimeType: "application/zip", data: "" }]);
});

test("native directory stays a file card and never reads directory contents", async () => {
  const folder = createNativeAttachmentFile("photos.png", DIRECTORY_MIME_TYPE, "C:\\Media\\photos.png", 0, true);
  const adapter = new QoneAttachmentAdapter();
  const sent = await adapter.send(await adapter.add({ file: folder }));
  expect(sent.type).toBe("file");
  expect(sent.file).toBe(folder);
  expect(sent.content).toEqual([{ type: "file", filename: "photos.png", mimeType: DIRECTORY_MIME_TYPE, data: "" }]);
});

test("dropped Electron folder File resolves its disk path instead of sending as 0 B file", async () => {
  const originalWindow = (globalThis as { window?: unknown }).window;
  const droppedFolder = new File([], "everytalk-srv", { type: "" });
  const folderPath = "C:\\Projects\\everytalk-srv";
  (globalThis as { window: unknown }).window = {
    electronBridge: {
      getPathForFile: (file: File) => (file === droppedFolder ? folderPath : ""),
      invoke: async (cmd: string, args: { path: string }) => {
        expect(cmd).toBe("inspect_dropped_file");
        expect(args.path).toBe(folderPath);
        return { name: "everytalk-srv", path: folderPath, size: 0, isDirectory: true };
      },
    },
  };
  try {
    const adapter = new QoneAttachmentAdapter();
    const pending = await adapter.add({ file: droppedFolder });
    expect(pending.contentType).toBe(DIRECTORY_MIME_TYPE);
    expect((pending.file as NativeAttachmentFile).qoneLocalPath).toBe(folderPath);
    expect((pending.file as NativeAttachmentFile).qoneIsDirectory).toBe(true);
    const complete = await adapter.send(pending);
    expect(complete.content).toEqual([{ type: "file", filename: "everytalk-srv", mimeType: DIRECTORY_MIME_TYPE, data: "" }]);
    expect(await serializeMessageAttachments({ attachments: [complete] } as unknown as AppendMessage)).toEqual([
      { type: "folder", name: "everytalk-srv", mimeType: DIRECTORY_MIME_TYPE, data: "", localPath: folderPath },
    ]);
  } finally {
    if (originalWindow === undefined) delete (globalThis as { window?: unknown }).window;
    else (globalThis as { window: unknown }).window = originalWindow;
  }
});
