import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import { decodeCommand, mediaMimeTypeFromName } from "@qone/protocol";
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

test("local media above 2 GB is passed to the provider without an app size cap", async () => {
  const file = createNativeAttachmentFile("oversized.mp4", "video/mp4", "C:\\Media\\oversized.mp4", 2_000_000_001);
  const input = { attachments: [{ type: "file", name: file.name, contentType: file.type, file, content: [] }] } as unknown as AppendMessage;
  expect(await serializeMessageAttachments(input)).toEqual([{
    type: "file", name: "oversized.mp4", mimeType: "video/mp4", data: "", localPath: "C:\\Media\\oversized.mp4",
  }]);
});

test("local video formats use the same MIME mapping as downloaded videos", async () => {
  expect(mediaMimeTypeFromName("src/app.ts")).toBeUndefined();
  for (const name of ["clip.flv", "clip.mpg", "clip.3gp"]) {
    const mimeType = mediaMimeTypeFromName(name);
    expect(mimeType?.startsWith("video/")).toBe(true);
    const file = createNativeAttachmentFile(name, mimeType!, `C:\\Media\\${name}`, 2_000_000_001);
    const input = { attachments: [{ type: "file", name, contentType: mimeType, file, content: [] }] } as unknown as AppendMessage;
    expect(await serializeMessageAttachments(input)).toEqual([{ type: "file", name, mimeType, data: "", localPath: `C:\\Media\\${name}` }]);
  }
});

test("multiple local media files pass through serialization and runtime protocol without a count cap", async () => {
  const files = Array.from({ length: 9 }, (_, index) => createNativeAttachmentFile(`clip-${index}.mp4`, "video/mp4", `C:\\Media\\clip-${index}.mp4`, 2_000_000_001));
  const input = { attachments: files.map((file) => ({ type: "file", name: file.name, contentType: file.type, file, content: [] })) } as unknown as AppendMessage;
  const attachments = await serializeMessageAttachments(input);
  expect(attachments).toHaveLength(files.length);
  expect(decodeCommand(JSON.stringify({ type: "agent.run", requestId: "request", sessionId: "session", message: "分析这些视频", attachments }))).not.toBeNull();
});

test("restored inline file attachments can be serialized again without a File object", async () => {
  const input = {
    attachments: [{
      type: "file",
      name: "restored.txt",
      contentType: "text/plain",
      content: [{ type: "file", filename: "restored.txt", mimeType: "text/plain", data: "data:text/plain;base64,SGk=" }],
    }],
  } as unknown as AppendMessage;
  expect(await serializeMessageAttachments(input)).toEqual([{
    type: "file", name: "restored.txt", mimeType: "text/plain", data: "data:text/plain;base64,SGk=",
  }]);
});
