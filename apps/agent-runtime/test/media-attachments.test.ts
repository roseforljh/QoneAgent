import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { videoAttachmentsAsAudio } from "../src/media-attachments";
import { promptWithAttachments } from "../src/pi-attachments";
import { ffmpegExecutable } from "../src/reach-channels";

const ffmpeg = ffmpegExecutable();
if (ffmpeg) test("audio-only executor extracts clipboard video without changing a local user file", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-attachment-audio-test-"));
  const source = path.join(directory, "source.mp4");
  const cleanup: string[] = [];
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
      "-t", "0.5", "-c:v", "mpeg4", "-c:a", "aac", source], { windowsHide: true });
    const sourceBytes = await readFile(source);
    const inline = await videoAttachmentsAsAudio([{ type: "file", name: "clip.mp4", mimeType: "video/mp4",
      data: `data:video/mp4;base64,${sourceBytes.toString("base64")}` }], (value) => cleanup.push(value));
    expect(inline?.[0]).toMatchObject({ mimeType: "audio/mp4", temporary: true, data: "" });
    expect((await stat(inline![0]!.localPath!)).isFile()).toBe(true);
    expect(promptWithAttachments("听声音", inline, "audio", ["text", "audio"])).toContain("QONE_MEDIA");
    const local = await videoAttachmentsAsAudio([{ type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: source }],
      (value) => cleanup.push(value));
    expect(local?.[0]?.localPath).not.toBe(source);
    expect(await readFile(source)).toEqual(sourceBytes);
    await expect(videoAttachmentsAsAudio([{ type: "file", name: "broken.mp4", mimeType: "video/mp4", data: "" }],
      (value) => cleanup.push(value))).rejects.toThrow("没有可读取的本地路径或 Base64 数据");
  } finally {
    await Promise.all(cleanup.map((value) => rm(value, { recursive: true, force: true })));
    await rm(directory, { recursive: true, force: true });
  }
});
