import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import { serializeMessageAttachments } from "../src/lib/message-attachments";
import { createNativeAttachmentFile } from "../src/lib/native-attachment-file";

test("text and image attachments retain their bytes, names and MIME types", async () => {
  const textFile = new File(["hello Qone"], "notes.txt", { type: "text/plain" });
  const input = {
    content: [{ type: "text", text: "read these" }],
    attachments: [
      { type: "document", name: "notes.txt", contentType: "text/plain", file: textFile, content: [{ type: "text", text: "hello Qone" }] },
      { type: "image", name: "plot.png", contentType: "image/png", content: [{ type: "image", image: "data:image/png;base64,aGVsbG8=" }] },
    ],
  } as unknown as AppendMessage;
  const attachments = await serializeMessageAttachments(input);
  expect(attachments).toEqual([
    { type: "file", name: "notes.txt", mimeType: "text/plain", data: "data:text/plain;charset=utf-8;base64,aGVsbG8gUW9uZQ==" },
    { type: "image", name: "plot.png", mimeType: "image/png", data: "data:image/png;base64,aGVsbG8=" },
  ]);
});

test("unsupported image formats fail before a message is sent", async () => {
  const input = { attachments: [{ type: "image", name: "vector.svg", contentType: "image/svg+xml", content: [{ type: "image", image: "data:image/svg+xml;base64,PHN2Zz4=" }] }] } as unknown as AppendMessage;
  expect(serializeMessageAttachments(input)).rejects.toThrow("不支持的图片格式");
});

test("large native media keeps only a local file reference", async () => {
  const file = createNativeAttachmentFile("recording.mp4", "video/mp4", "C:\\Media\\recording.mp4", 900_000_000);
  const input = { attachments: [{ type: "file", name: file.name, contentType: file.type, file, content: [{ type: "file", filename: file.name, mimeType: file.type, data: "" }] }] } as unknown as AppendMessage;
  expect(await serializeMessageAttachments(input)).toEqual([{
    type: "file", name: "recording.mp4", mimeType: "video/mp4", data: "", localPath: "C:\\Media\\recording.mp4",
  }]);
});

test("local media above the Gemini 2 GB limit is rejected before sending", async () => {
  const file = createNativeAttachmentFile("oversized.mp4", "video/mp4", "C:\\Media\\oversized.mp4", 2_000_000_001);
  const input = { attachments: [{ type: "file", name: file.name, contentType: file.type, file, content: [] }] } as unknown as AppendMessage;
  expect(serializeMessageAttachments(input)).rejects.toThrow("2 GB");
});
