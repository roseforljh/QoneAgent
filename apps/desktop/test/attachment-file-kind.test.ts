import { expect, test } from "bun:test";
import { attachmentFileIcon, attachmentFileKind, attachmentFileLabel } from "../src/lib/attachment-file-kind";

test("attachment icons distinguish file families using MIME and extension", () => {
  const samples = [
    ["report.pdf", "application/pdf", "pdf"],
    ["sales.xlsx", "application/octet-stream", "spreadsheet"],
    ["slides.pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation", "presentation"],
    ["memo.docx", "application/octet-stream", "document"],
    ["main.ts", "application/octet-stream", "code"],
    ["bundle.zip", "application/zip", "archive"],
    ["voice.wav", "audio/wav", "audio"],
    ["clip.mp4", "video/mp4", "video"],
    ["portrait.png", "image/png", "image"],
    ["unrecognized.bin", "application/octet-stream", "file"],
    ["portrait.png", "inode/directory", "folder"],
  ] as const;
  for (const [name, mimeType, kind] of samples) {
    expect(attachmentFileKind(name, mimeType)).toBe(kind);
    expect(attachmentFileIcon(name, mimeType)).toMatch(/\.svg$/);
  }
  expect(new Set(samples.map(([name, mime]) => attachmentFileIcon(name, mime))).size).toBe(11);
  expect(attachmentFileLabel("report.pdf", "application/pdf")).toBe("PDF");
  expect(attachmentFileLabel("source", "inode/directory")).toBe("");
});
