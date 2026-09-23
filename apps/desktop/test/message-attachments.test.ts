import { expect, test } from "bun:test";
import type { AppendMessage } from "@assistant-ui/react";
import { serializeMessageAttachments } from "../src/lib/message-attachments";

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
