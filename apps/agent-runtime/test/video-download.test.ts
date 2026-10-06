import { expect, spyOn, test } from "bun:test";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ffmpegExecutable, ytDlpExecutable } from "../src/reach-channels";
import { downloadAudio, downloadDouyinVideo, downloadVideo, extractVideoAudio, mediaMimeType, videoMimeType } from "../src/video-download";

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

test("Douyin bridge rejects partial or non-video responses instead of saving them", async () => {
  const server = Bun.serve({
    port: 0,
    fetch: (request) => request.url.endsWith("/partial")
      ? new Response(Buffer.from("tiny"), { status: 206, headers: { "Content-Type": "video/mp4", "Content-Range": "bytes 0-3/8" } })
      : new Response("blocked", { headers: { "Content-Type": "text/html", "Content-Length": "7" } }),
  });
  try {
    const resolve = (path: string) => Promise.resolve({ videoUrl: `http://127.0.0.1:${server.port}${path}`, pageUrl: "https://www.douyin.com/video/1" });
    await expect(downloadDouyinVideo("https://www.douyin.com/video/1", () => resolve("/partial"))).rejects.toMatchObject({ code: "video-download.douyin_partial_stream" });
    await expect(downloadDouyinVideo("https://www.douyin.com/video/1", () => resolve("/html"))).rejects.toMatchObject({ code: "video-download.douyin_non_video_response" });
  } finally {
    server.stop(true);
  }
});

test("Douyin accepts complete streams and checks binary content, length and browser headers", async () => {
  const bytes = Buffer.from("0000ftypisom0000");
  const resolved = { videoUrl: "https://v.douyinvod.com/media.mp4", pageUrl: "https://www.douyin.com/video/1", userAgent: "TestBrowser/1.0" };
  const transport = spyOn(globalThis, "fetch");
  try {
    for (const headers of [
      { "Content-Type": "video/mp4", "Content-Length": String(bytes.length) },
      { "Content-Type": "video/mp4", "Content-Length": "3", "Content-Encoding": "gzip" },
      { "Content-Type": "video/mp4", "Content-Range": `bytes 0-${bytes.length - 1}/${bytes.length}` },
    ]) {
      transport.mockResolvedValueOnce(new Response(bytes, { status: headers["Content-Range"] ? 206 : 200, headers }));
      const downloaded = await downloadDouyinVideo(resolved.pageUrl, async () => resolved);
      try { expect(await readFile(downloaded.path)).toEqual(bytes); }
      finally { await rm(downloaded.directory, { recursive: true, force: true }); }
    }
    expect(transport.mock.calls[0]?.[1]?.headers).toMatchObject({ "User-Agent": resolved.userAgent, Referer: resolved.pageUrl });
    const webm = Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0, 0, 0, 0, 0]);
    transport.mockResolvedValueOnce(new Response(webm, { headers: { "Content-Type": "application/octet-stream" } }));
    const downloadedWebm = await downloadDouyinVideo(resolved.pageUrl, async () => resolved);
    try {
      expect(downloadedWebm.mimeType).toBe("video/webm");
      expect(path.extname(downloadedWebm.path)).toBe(".webm");
      expect(await readFile(downloadedWebm.path)).toEqual(webm);
    } finally { await rm(downloadedWebm.directory, { recursive: true, force: true }); }
    transport.mockResolvedValueOnce(new Response(bytes, { headers: { "Content-Type": "video/mp4", "Content-Length": "999" } }));
    await expect(downloadDouyinVideo(resolved.pageUrl, async () => resolved)).rejects.toMatchObject({ code: "video-download.douyin_incomplete_stream" });
    transport.mockResolvedValueOnce(new Response("<html>blocked</html>", { headers: { "Content-Type": "application/octet-stream" } }));
    await expect(downloadDouyinVideo(resolved.pageUrl, async () => resolved)).rejects.toMatchObject({ code: "video-download.douyin_non_video_response" });
  } finally { transport.mockRestore(); }
});

test("Douyin downloads the next verified CDN mirror after an invalid stream", async () => {
  const bytes = Buffer.from("0000ftypisom0000");
  const calls: string[] = [];
  const server = Bun.serve({ port: 0, fetch: (request) => {
    const pathname = new URL(request.url).pathname;
    calls.push(pathname);
    return pathname === "/first" ? new Response("denied", { status: 403 })
      : new Response(bytes, { headers: { "Content-Type": "video/mp4" } });
  } });
  try {
    const videoUrls = ["first", "second"].map((name) => `http://127.0.0.1:${server.port}/${name}`);
    const downloaded = await downloadDouyinVideo("https://www.douyin.com/video/123", async (pageUrl) => ({ pageUrl, videoUrl: videoUrls[0]!, videoUrls }));
    try {
      expect(calls).toEqual(["/first", "/second"]);
      expect(await readFile(downloaded.path)).toEqual(bytes);
    } finally { await rm(downloaded.directory, { recursive: true, force: true }); }
  } finally { server.stop(true); }
});
