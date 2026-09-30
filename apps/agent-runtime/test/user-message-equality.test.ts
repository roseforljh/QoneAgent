import { describe, expect, test } from "bun:test";
import { repeatedUserMessageId, sameUserInput, type MessageAttachmentInfo } from "@qone/protocol";

const file: MessageAttachmentInfo = {
  type: "file", name: "note.txt", mimeType: "text/plain", data: "data:text/plain;base64,YQ==",
};
const user = (id: string, content = "same", attachments?: MessageAttachmentInfo[]) => ({ id, role: "user", content, attachments });

describe("exact user input equality", () => {
  test("compares body exactly and treats absent attachments as an empty list", () => {
    expect(sameUserInput({ content: "same" }, { content: "same", attachments: [] })).toBe(true);
    expect(sameUserInput({ content: "same" }, { content: " same" })).toBe(false);
    expect(sameUserInput({ content: "same" }, { content: "Same" })).toBe(false);
    expect(sameUserInput({ content: "a\nb" }, { content: "a b" })).toBe(false);
  });

  test("compares every serialized attachment field and ignores object key order", () => {
    const input = { content: "same", attachments: [file] };
    expect(sameUserInput(input, { content: "same", attachments: [{ data: file.data, mimeType: file.mimeType, name: file.name, type: file.type }] })).toBe(true);
    for (const changed of [
      { ...file, type: "image" as const }, { ...file, name: "other.txt" },
      { ...file, mimeType: "application/octet-stream" }, { ...file, data: "data:text/plain;base64,Yg==" },
      { ...file, localPath: "C:/other.txt" },
    ]) expect(sameUserInput(input, { content: "same", attachments: [changed] })).toBe(false);
    expect(sameUserInput(input, { content: "same" })).toBe(false);
    expect(sameUserInput(input, { content: "same", attachments: [file, file] })).toBe(false);
  });

  test("attachment order and local file or folder identity matter", () => {
    const folder: MessageAttachmentInfo = { type: "folder", name: "src", mimeType: "inode/directory", data: "", localPath: "C:/project/src" };
    expect(sameUserInput({ content: "", attachments: [file, folder] }, { content: "", attachments: [folder, file] })).toBe(false);
    expect(sameUserInput({ content: "", attachments: [folder] }, { content: "", attachments: [{ ...folder }] })).toBe(true);
    expect(sameUserInput({ content: "", attachments: [folder] }, { content: "", attachments: [{ ...folder, localPath: "C:/other/src" }] })).toBe(false);
  });
});

describe("adjacent user bubbles", () => {
  test("returns the first identical bubble in the trailing group", () => {
    expect(repeatedUserMessageId([], { content: "same" })).toBeUndefined();
    expect(repeatedUserMessageId([user("1"), user("2"), user("3")], { content: "same" })).toBe("1");
    expect(repeatedUserMessageId([user("1", "different"), user("2"), user("3")], { content: "same" })).toBe("2");
  });

  test("answers and different user inputs break the group", () => {
    const answer = { id: "answer", role: "assistant", content: "answer" };
    expect(repeatedUserMessageId([user("1"), answer], { content: "same" })).toBeUndefined();
    expect(repeatedUserMessageId([user("1"), answer, user("2")], { content: "same" })).toBe("2");
    expect(repeatedUserMessageId([user("1"), user("2", "different")], { content: "same" })).toBeUndefined();
    expect(repeatedUserMessageId([user("1", "same", [file])], { content: "same", attachments: [{ ...file, data: "changed" }] })).toBeUndefined();
  });
});
