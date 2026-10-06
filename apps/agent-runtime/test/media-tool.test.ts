import { expect, test } from "bun:test";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { ModelConfigInfo } from "@qone/protocol";
import { createAttachmentAudioTool, createAttachmentFrameTool, createVideoDownloadTool, createVideoFallbackTools, type MediaToolOptions } from "../src/media-tool";
import { bilibiliCliResultText, readBilibiliVideoData } from "../src/bilibili-fallback";
import { ffmpegExecutable, ytDlpExecutable } from "../src/reach-channels";
import { extractVideoFrames, videoDuration } from "../src/video-frames";
import { convertResponsesMessages } from "@earendil-works/pi-ai/api/openai-responses-shared";
import { normalizeContext } from "@earendil-works/pi-ai";

const model = { provider: "provider", id: "gemini", api: "google-generative-ai" };
function setup(input: string[], selected = model): { options: MediaToolOptions; dirs: Set<string> } {
  const dirs = new Set<string>();
  const configs = [{ id: `${selected.provider}/${selected.id}`, provider: selected.provider, model: selected.id, enabled: true,
    updatedAt: 1, config: { apiType: selected.api === "google-generative-ai" ? "google" : "openai-compatible", input, output: ["text"], metadataOverrides: { input: true } } }] as ModelConfigInfo[];
  return { dirs, options: {
    active: () => ({ runId: "run", model: selected }), configs: () => configs,
    registerMedia: (_runId, _path, _mimeType, directory) => { if (directory) dirs.add(directory); },
    registerDirectory: (_runId, directory) => { dirs.add(directory); },
    isTemporary: (_runId, filePath) => [...dirs].some((dir) => path.dirname(filePath) === dir),
  } };
}

test("Bilibili recognition uses the embedded app route before fallback adapters", async () => {
  const { options, dirs } = setup(["text", "video"]);
  const directory = await mkdtemp(path.join(tmpdir(), "qone-bilibili-route-test-"));
  const filePath = path.join(directory, "video.mp4");
  await writeFile(filePath, Buffer.from([0, 1, 2]));
  options.bilibiliDownload = async () => ({ path: filePath, mimeType: "video/mp4", directory });
  try {
    const result = await createVideoDownloadTool(options).execute("call", { url: "https://www.bilibili.com/video/BV1xx411c7mD" }, new AbortController().signal);
    expect((result.details as { source: string }).source).toBe("哔哩哔哩 yt-dlp");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("media staging refuses a model without audio or video input", async () => {
  const { options, dirs } = setup(["text"]);
  const [staging] = createVideoFallbackTools(options);
  await expect(staging!.execute("call", {}, new AbortController().signal)).rejects.toThrow("请委派原始链接");
  expect(dirs.size).toBe(0);
});

test("Gemini video recognition refuses a YouTube download so the native URL path remains available", async () => {
  const { options } = setup(["text", "video"]);
  await expect(createVideoDownloadTool(options).execute("call", {
    url: "https://www.youtube.com/watch?v=example123",
  }, new AbortController().signal)).rejects.toThrow("Gemini 可直接识别 YouTube 链接，无需下载");
});

test("Chat Completions audio model can use a downloaded audio file, but cannot claim video input", async () => {
  const chatModel = { provider: "provider", id: "chat-audio", api: "openai-completions" };
  const { options, dirs } = setup(["text", "audio"], chatModel);
  const [staging, useFile] = createVideoFallbackTools(options);
  const staged = await staging!.execute("call", {}, new AbortController().signal);
  const directory = (staged.details as { directory: string }).directory;
  try {
    const audio = path.join(directory, "sound.mp3");
    await writeFile(audio, Buffer.from([1, 2]));
    const result = await useFile!.execute("call", { path: audio }, new AbortController().signal);
    expect(JSON.stringify(result.content)).toContain("QONE_MEDIA");
    const videoConfigured = setup(["text", "video", "audio"], chatModel);
    await expect(createVideoDownloadTool(videoConfigured.options).execute("call", { url: "https://example.test/clip.mp4" }, new AbortController().signal))
      .rejects.toThrow("需要画面时请配置图像输入");
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
});

const ffmpeg = ffmpegExecutable();
if (ffmpeg) test("non-Gemini visual model receives selected still frames through the generic image path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-frame-tool-test-"));
  const video = path.join(directory, "clip.mp4");
  const modelWithVision = { provider: "provider", id: "vision", api: "openai-responses" };
  const { options, dirs } = setup(["text", "image", "video"], modelWithVision);
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=32x32:r=2", "-t", "0.5", "-c:v", "mpeg4", video], { windowsHide: true });
    const frames = await extractVideoFrames(video, [0]);
    dirs.add(frames.directory);
    expect(frames.frames).toHaveLength(1);
    expect(frames.frames[0]).toMatchObject({ seconds: 0, image: { type: "image", mimeType: "image/jpeg" } });
    const [staging, useFile] = createVideoFallbackTools(options);
    const staged = await staging!.execute("call", {}, new AbortController().signal);
    const stagedPath = path.join((staged.details as { directory: string }).directory, "clip.mp4");
    await copyFile(video, stagedPath);
    const info = await useFile!.execute("call", { path: stagedPath }, new AbortController().signal);
    expect((info.details as { duration: number; videoRead: boolean }).duration).toBeGreaterThan(0);
    expect((info.details as { videoRead: boolean }).videoRead).toBe(false);
    const result = await useFile!.execute("call", { path: stagedPath, timestamps: [0] }, new AbortController().signal);
    expect((result.details as { transport: string; frameCount: number }).transport).toBe("image-frames");
    expect((result.details as { frameCount: number }).frameCount).toBeGreaterThan(0);
    expect(result.content.some((part) => part.type === "image")).toBe(true);
  } finally {
    for (const value of dirs) await rm(value, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});
if (ffmpeg) test("video metadata rejects invalid bytes before requesting frames", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-invalid-video-test-"));
  try {
    const file = path.join(directory, "invalid.mp4");
    await writeFile(file, Buffer.from("not a video"));
    await expect(videoDuration(file)).rejects.toThrow("FFmpeg 无法读取视频文件");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
if (ffmpeg) test("attachment audio is extracted only when the consuming agent calls its tool", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-attachment-tool-test-"));
  const video = path.join(directory, "clip.mp4");
  const audioModel = { provider: "provider", id: "chat-audio", api: "openai-completions" };
  const { options, dirs } = setup(["text", "audio"], audioModel);
  const media: string[] = [];
  options.attachment = (_runId, id) => id === "video-ref" ? { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: video } : undefined;
  options.registerMedia = (_runId, filePath) => { media.push(filePath); };
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
      "-t", "0.5", "-c:v", "mpeg4", "-c:a", "aac", video], { windowsHide: true });
    const original = await readFile(video);
    expect(dirs.size).toBe(0);
    const tool = createAttachmentAudioTool(options);
    await expect(tool.execute("call", { attachmentId: "missing" }, new AbortController().signal)).rejects.toThrow("未找到当前任务的视频附件引用");
    expect(dirs.size).toBe(0);
    const result = await tool.execute("call", { attachmentId: "video-ref" }, new AbortController().signal);
    expect(JSON.stringify(result.content)).toContain("QONE_MEDIA");
    expect((result.details as { videoRead: boolean }).videoRead).toBe(false);
    expect(media).toHaveLength(1);
    expect(await readFile(video)).toEqual(original);
  } finally {
    for (const value of dirs) await rm(value, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

if (ffmpeg) test("video attachment frames are extracted only by a capable consuming agent", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-attachment-frames-test-"));
  const video = path.join(directory, "clip.mp4");
  const visionModel = { provider: "provider", id: "vision", api: "openai-responses" };
  const { options, dirs } = setup(["text", "video", "image"], visionModel);
  options.attachment = (_runId, id) => id === "video-ref"
    ? { type: "file", name: "clip.mp4", mimeType: "video/mp4", data: "", localPath: video }
    : undefined;
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=red:s=32x32:r=2", "-t", "0.5", "-c:v", "mpeg4", video], { windowsHide: true });
    const original = await readFile(video);
    const tool = createAttachmentFrameTool(options);
    expect(dirs.size).toBe(0);
    await expect(tool.execute("call", { attachmentId: "missing" }, new AbortController().signal)).rejects.toThrow("未找到当前任务的视频附件引用");
    expect(dirs.size).toBe(0);
    const info = await tool.execute("call", { attachmentId: "video-ref" }, new AbortController().signal);
    expect((info.details as { duration: number; videoRead: boolean }).duration).toBeGreaterThan(0);
    expect((info.details as { videoRead: boolean }).videoRead).toBe(false);
    const result = await tool.execute("call", { attachmentId: "video-ref", timestamps: [0] }, new AbortController().signal);
    expect((result.details as { transport: string; frameCount: number }).transport).toBe("image-frames");
    expect(result.content.some((part) => part.type === "image")).toBe(true);
    expect(result.content.some((part) => part.type === "text" && part.text.includes("画面时间：0 秒"))).toBe(true);
    const request = convertResponsesMessages({ provider: "provider", id: "vision", api: "openai-responses", input: ["text", "image"] } as never,
      normalizeContext({ messages: [
        { role: "user", content: "分析视频", timestamp: 1 },
        { role: "assistant", provider: "provider", model: "vision", api: "openai-responses", content: [
          { type: "toolCall", id: "call", name: "qone_media_extract_frames", arguments: { attachmentId: "video-ref" } },
        ], stopReason: "toolUse", timestamp: 2 },
        { role: "toolResult", toolCallId: "call", toolName: "qone_media_extract_frames", content: result.content, isError: false, timestamp: 3 },
      ] as never }), undefined);
    const output = request.find((item) => item.type === "function_call_output") as { output: unknown[] } | undefined;
    expect(output?.output).toContainEqual(expect.objectContaining({ type: "input_image" }));
    expect(await readFile(video)).toEqual(original);
    const incapable = setup(["text", "video"], visionModel);
    incapable.options.attachment = options.attachment;
    await expect(createAttachmentFrameTool(incapable.options).execute("call", { attachmentId: "video-ref" }, new AbortController().signal))
      .rejects.toThrow("请委派原始附件");
    expect(incapable.dirs.size).toBe(0);
  } finally {
    for (const value of dirs) await rm(value, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

if (ffmpeg) test("a model configured for both media types can request only the sound", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-video-audio-mode-test-"));
  const source = path.join(directory, "clip.mp4");
  const dualModel = { provider: "provider", id: "dual", api: "openai-completions" };
  const { options, dirs } = setup(["text", "video", "audio"], dualModel);
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
      "-t", "0.5", "-c:v", "mpeg4", "-c:a", "aac", source], { windowsHide: true });
    const [staging, useFile] = createVideoFallbackTools(options);
    const staged = await staging!.execute("call", {}, new AbortController().signal);
    const stagedPath = path.join((staged.details as { directory: string }).directory, "clip.mp4");
    await copyFile(source, stagedPath);
    const result = await useFile!.execute("call", { path: stagedPath, mode: "audio" }, new AbortController().signal);
    expect((result.details as { videoRead: boolean }).videoRead).toBe(false);
    expect(JSON.stringify(result.content)).toContain("QONE_MEDIA");
    const visual = setup(["text", "video", "audio", "image"], dualModel);
    try {
      const [visualStaging, visualUseFile] = createVideoFallbackTools(visual.options);
      const prepared = await visualStaging!.execute("call", {}, new AbortController().signal);
      const sameFile = path.join((prepared.details as { directory: string }).directory, "clip.mp4");
      await copyFile(source, sameFile);
      const frames = await visualUseFile!.execute("call", { path: sameFile, timestamps: [0] }, new AbortController().signal);
      expect(frames.content[0]).toMatchObject({ type: "text", text: expect.stringContaining(sameFile) });
      expect(frames.content.some((part) => part.type === "image")).toBe(true);
      const sound = await visualUseFile!.execute("call", { path: sameFile, mode: "audio" }, new AbortController().signal);
      expect(JSON.stringify(sound.content)).toContain("QONE_MEDIA");
      expect((sound.details as { videoRead: boolean }).videoRead).toBe(false);
    } finally {
      for (const value of visual.dirs) await rm(value, { recursive: true, force: true });
    }
  } finally {
    for (const value of dirs) await rm(value, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

if (ffmpeg && ytDlpExecutable()) test("audio mode gets sound from a combined video URL", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-audio-url-test-"));
  const video = path.join(directory, "clip.mp4");
  const audioModel = { provider: "provider", id: "audio-url", api: "openai-completions" };
  const { options, dirs } = setup(["text", "audio"], audioModel);
  try {
    await promisify(execFile)(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error",
      "-f", "lavfi", "-i", "color=c=black:s=16x16:r=2",
      "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=8000",
      "-t", "0.5", "-c:v", "mpeg4", "-c:a", "aac", video], { windowsHide: true });
    const server = Bun.serve({ port: 0, fetch: () => new Response(Bun.file(video), { headers: { "Content-Type": "video/mp4" } }) });
    try {
      const result = await createVideoDownloadTool(options).execute("call", { url: `http://127.0.0.1:${server.port}/clip.mp4`, mode: "audio" }, new AbortController().signal);
      expect((result.details as { mimeType: string }).mimeType.startsWith("audio/")).toBe(true);
      expect(JSON.stringify(result.content)).toContain("QONE_MEDIA");
      expect(result.content.some((part) => part.type === "image")).toBe(false);
    } finally {
      server.stop(true);
    }
  } finally {
    for (const value of dirs) await rm(value, { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

test("Bilibili CLI error envelope cannot masquerade as analysis data", () => {
  expect(bilibiliCliResultText('{"ok":true,"data":{"title":"example"}}')).toContain("example");
  expect(() => bilibiliCliResultText('{"ok":false,"error":{"message":"login required"}}')).toThrow("login required");
});

test("Bilibili subtitle JSON failure falls back to metadata and cancellation does not retry", async () => {
  const calls: boolean[] = [];
  const read = async (subtitles: boolean) => {
    calls.push(subtitles);
    return JSON.stringify(subtitles ? { ok: false, error: "login required" } : { ok: true, data: { title: "video" } });
  };
  expect(await readBilibiliVideoData(read)).toContain('"title":"video"');
  expect(calls).toEqual([true, false]);
  calls.length = 0;
  await expect(readBilibiliVideoData(read, AbortSignal.abort())).rejects.toThrow("login required");
  expect(calls).toEqual([true]);
});

test("site fallback uses only a file in this run's staging directory", async () => {
  const { options, dirs } = setup(["text", "video"]);
  const [staging, useFile] = createVideoFallbackTools(options);
  const result = await staging!.execute("call", {}, new AbortController().signal);
  const directory = (result.details as { directory: string }).directory;
  const unrelated = await mkdtemp(path.join(tmpdir(), "qone-unrelated-"));
  try {
    const video = path.join(directory, "clip.mp4");
    const other = path.join(unrelated, "clip.mp4");
    await writeFile(video, Buffer.from([0, 1, 2]));
    await writeFile(other, Buffer.from([0, 1, 2]));
    await expect(useFile!.execute("call", { path: other }, new AbortController().signal)).rejects.toThrow("当前任务的临时下载目录");
    const used = await useFile!.execute("call", { path: video }, new AbortController().signal);
    expect(JSON.stringify(used.content)).toContain("QONE_MEDIA");
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
    await rm(unrelated, { recursive: true, force: true });
  }
});

test("video file tool rejects an audio file when video mode is requested", async () => {
  const { options, dirs } = setup(["text", "video", "image"], { provider: "provider", id: "vision", api: "openai-responses" });
  const [staging, useFile] = createVideoFallbackTools(options);
  const result = await staging!.execute("call", {}, new AbortController().signal);
  const directory = (result.details as { directory: string }).directory;
  try {
    const audio = path.join(directory, "sound.mp3");
    await writeFile(audio, Buffer.from([1, 2]));
    await expect(useFile!.execute("call", { path: audio, mode: "video" }, new AbortController().signal))
      .rejects.toThrow("mode=video 需要视频文件");
  } finally {
    for (const dir of dirs) await rm(dir, { recursive: true, force: true });
  }
});
