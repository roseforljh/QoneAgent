import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { localMediaMarker } from "../src/google-media";
import { prepareOpenAICompletionsPayload } from "../src/openai-audio";
import { promptWithAttachments } from "../src/pi-attachments";
import { ffmpegExecutable } from "../src/reach-channels";

const execFileAsync = promisify(execFile);

test("Chat Completions sends a local audio file as input_audio rather than a path", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-chat-audio-test-"));
  const file = path.join(directory, "sample.mp3");
  await writeFile(file, Buffer.from([1, 2, 3, 4]));
  try {
    const marker = promptWithAttachments("请听", [{ type: "file", name: "sample.mp3", mimeType: "audio/mpeg", data: "", localPath: file }], "audio", ["text", "audio"]);
    const result = await prepareOpenAICompletionsPayload({ messages: [{ role: "user", content: marker }] }, ["text", "audio"]);
    const parts = result.messages?.[0]?.content as Array<{ type: string; text?: string; input_audio?: { data: string; format: string } }>;
    expect(parts.map((part) => part.type)).toEqual(["text", "input_audio"]);
    expect(parts[1]?.input_audio).toEqual({ data: "AQIDBA==", format: "mp3" });
    expect(JSON.stringify(result)).not.toContain(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Chat Completions adds tool audio after the contiguous tool result group", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-chat-tool-audio-test-"));
  const file = path.join(directory, "sample.mp3");
  await writeFile(file, Buffer.from([5, 6]));
  try {
    const marker = localMediaMarker(file, "audio/mpeg", true);
    const result = await prepareOpenAICompletionsPayload({ messages: [
      { role: "assistant", content: null, tool_calls: [{ id: "call1" }, { id: "call2" }] },
      { role: "tool", tool_call_id: "call1", content: `下载完成 ${marker}` },
      { role: "tool", tool_call_id: "call2", content: "另一条结果" },
    ] }, ["text", "audio"]);
    expect(result.messages?.map((message) => message.role)).toEqual(["assistant", "tool", "tool", "user"]);
    expect(result.messages?.[1]?.content).toBe("下载完成 ");
    expect((result.messages?.[3]?.content as Array<{ type: string }>).at(-1)?.type).toBe("input_audio");
    await rm(directory, { recursive: true, force: true });
    const replay = await prepareOpenAICompletionsPayload({ messages: [{ role: "user", content: marker }] }, ["text", "audio"]);
    expect(JSON.stringify(replay)).toContain("已清理或不存在");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Chat Completions translates inline audio and video into native parts", async () => {
  const inline = await prepareOpenAICompletionsPayload({ messages: [{ role: "user", content: [
    { type: "text", text: "听这个" },
    { type: "image_url", image_url: { url: "data:audio/mpeg;base64,AQID" } },
  ] }] }, ["text", "audio"]);
  expect((inline.messages?.[0]?.content as Array<{ type: string; input_audio?: { format: string } }>)[1]).toMatchObject({
    type: "input_audio", input_audio: { format: "mp3" },
  });
  const directory = await mkdtemp(path.join(tmpdir(), "qone-chat-video-test-"));
  const video = path.join(directory, "clip.mp4");
  await writeFile(video, Buffer.from([1, 2, 3]));
  try {
    const result = await prepareOpenAICompletionsPayload({ messages: [{ role: "user", content: localMediaMarker(video, "video/mp4") }] }, ["text", "video"]);
    expect((result.messages?.[0]?.content as Array<{ type: string }>)[0]?.type).toBe("video_url");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

const ffmpeg = ffmpegExecutable();
if (ffmpeg) test("Chat Completions converts a downloaded M4A sound track to MP3", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-chat-audio-convert-"));
  try {
    const file = path.join(directory, "sound.m4a");
    await execFileAsync(ffmpeg, ["-nostdin", "-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "sine=frequency=440:duration=0.05", "-c:a", "aac", file], { windowsHide: true });
    const result = await prepareOpenAICompletionsPayload({ messages: [{ role: "user", content: localMediaMarker(file, "audio/mp4") }] }, ["text", "audio"]);
    const part = (result.messages?.[0]?.content as Array<{ type: string; input_audio?: { data: string; format: string } }>)[0];
    expect(part?.input_audio?.format).toBe("mp3");
    expect(Buffer.from(part?.input_audio?.data ?? "", "base64").length).toBeGreaterThan(0);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
