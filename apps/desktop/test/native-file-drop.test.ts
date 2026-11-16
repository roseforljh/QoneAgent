import { expect, test } from "bun:test";
import { fileFromNativeInfo, isInsideNativeDropTarget } from "../src/lib/native-file-drop";
import type { NativeAttachmentFile } from "../src/lib/native-attachment-file";

test("native picker and drop metadata keep the original path for every file type", () => {
  for (const [name, mimeType] of [
    ["plot.png", "image/png"],
    ["report.zip", "application/zip"],
    ["notes.txt", "text/plain"],
    ["clip.mp4", "video/mp4"],
    ["voice.mp3", "audio/mpeg"],
  ]) {
    const path = `C:\\Attachments\\${name}`;
    const file = fileFromNativeInfo({ name: name!, path, size: 123_456_789, isDirectory: false }) as NativeAttachmentFile;
    expect(file.qoneLocalPath).toBe(path);
    expect(file.qoneFileSize).toBe(123_456_789);
    expect(file.type.split(";", 1)[0]).toBe(mimeType);
    expect(file.size).toBe(0);
  }
});

test("native folder metadata keeps its original directory path without reading contents", () => {
  const path = "C:\\Attachments\\reports.png";
  const folder = fileFromNativeInfo({ name: "reports.png", path, size: 0, isDirectory: true }) as NativeAttachmentFile;
  expect(folder.qoneLocalPath).toBe(path);
  expect(folder.qoneIsDirectory).toBe(true);
  expect(folder.type).toBe("inode/directory");
  expect(folder.size).toBe(0);
});

test("drop hit testing uses CSS coordinates without false matches on HiDPI displays", () => {
  const sidebar = { getBoundingClientRect: () => ({ left: 0, right: 260, top: 0, bottom: 800 }) } as unknown as HTMLElement;
  expect(isInsideNativeDropTarget(sidebar, { x: 120, y: 200 })).toBe(true);
  expect(isInsideNativeDropTarget(sidebar, { x: 350, y: 200 })).toBe(false);
});
