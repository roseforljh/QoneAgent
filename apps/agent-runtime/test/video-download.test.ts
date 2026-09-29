import { expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ffmpegExecutable, ytDlpExecutable } from "../src/reach-channels";
import { downloadAudio, downloadVideo, extractVideoAudio, mediaMimeType, videoMimeType } from "../src/video-download";

test("download and local attachment routes agree on video containers", () => {
  expect(videoMimeType("clip.flv")).toBe("video/x-flv");
  expect(videoMimeType("clip.mpg")).toBe("video/mpeg");
  expect(videoMimeType("clip.3gp")).toBe("video/3gpp");
  expect(mediaMimeType("sound.ogg")).toBe("audio/ogg");
});

test("yt-dlp downloads a video into a temporary directory", async () => {
  if (!ytDlpExecutable()) return;
  const bytes = Buffer.from([0, 1, 2, 3]);
  const server = Bun.serve({ port: 0, fetch: () => new Response(bytes, { headers: { "Content-Type": "video/mp4" } }) });
  try {
    const video = await downloadVideo(`http://127.0.0.1:${server.port}/clip.mp4`);
    try {
      expect(video.mimeType).toBe("video/mp4");
      expect(await readFile(video.path)).toEqual(bytes);
    } finally {
      await rm(video.directory, { recursive: true, force: true });
    }
  } finally {
    server.stop(true);
  }
});

test("audio-only download uses yt-dlp's audio format instead of downloading video", async () => {
  const ffmpeg = ffmpegExecutable();
  if (!ytDlpExecutable() || !ffmpeg) return;
  const directory = await mkdtemp(path.join(tmpdir(), "qone-audio-source-test-"));
  const source = path.join(directory, "sound.mp3");
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "sine=frequency=440:duration=0.5", source], { windowsHide: true });
    const server = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(source), { headers: { "Content-Type": "audio/mpeg" } }) });
    try {
      const audio = await downloadAudio(`http://127.0.0.1:${server.port}/sound.mp3`);
      try {
        expect(audio.mimeType).toBe("audio/mpeg");
        expect(path.extname(audio.path)).toBe(".mp3");
        expect((await readFile(audio.path)).byteLength).toBeGreaterThan(0);
      } finally {
        await rm(audio.directory, { recursive: true, force: true });
      }
    } finally {
      server.stop(true);
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("audio agent extracts an existing video soundtrack without redownloading", async () => {
  const ffmpeg = ffmpegExecutable();
  if (!ffmpeg) return;
  const directory = await mkdtemp(path.join(tmpdir(), "qone-audio-test-"));
  const source = path.join(directory, "source.mp4");
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
      "-t", "1", "-c:v", "mpeg4", "-c:a", "aac", source], { windowsHide: true });
    const audio = await extractVideoAudio(source);
    try {
      expect(audio.mimeType).toBe("audio/mp4");
      expect((await readFile(audio.path)).byteLength).toBeGreaterThan(0);
    } finally {
      await rm(audio.directory, { recursive: true, force: true });
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
