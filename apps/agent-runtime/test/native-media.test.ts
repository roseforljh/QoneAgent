import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { localMediaMarker } from "../src/google-media";
import { prepareOpenAIResponsesPayload } from "../src/openai-responses-media";
import { prepareAnthropicPayload } from "../src/anthropic-media";

test("Responses and Codex transport complete video files as input_file parts", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-native-responses-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, Buffer.from([1, 2, 3]));
  try {
    const marker = localMediaMarker(file, "video/mp4", true);
    const payload = await prepareOpenAIResponsesPayload({ input: [{ role: "user", content: [{ type: "input_text", text: `分析 ${marker}` }] }] }, ["text", "video"]);
    const content = (payload.input as Array<{ content: unknown[] }>)[0]!.content;
    expect(content[1]).toMatchObject({ type: "input_file", filename: "clip.mp4", file_data: "data:video/mp4;base64,AQID" });
    expect(JSON.stringify(payload)).not.toContain(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude transport uses a native document block for configured audio", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-native-claude-"));
  const file = path.join(directory, "sound.mp3");
  await writeFile(file, Buffer.from([4, 5, 6]));
  try {
    const marker = localMediaMarker(file, "audio/mpeg", true);
    const payload = await prepareAnthropicPayload({ messages: [{ role: "user", content: `听 ${marker}` }] }, ["text", "audio"]);
    const content = (payload.messages as Array<{ content: unknown[] }>)[0]!.content;
    expect(content[1]).toMatchObject({ type: "document", source: { type: "base64", media_type: "audio/mpeg", data: "BAUG" } });
    expect(JSON.stringify(payload)).not.toContain(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("Claude transport uses the configured native video input instead of a frame representation", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "qone-native-claude-video-"));
  const file = path.join(directory, "clip.mp4");
  await writeFile(file, Buffer.from([7, 8, 9]));
  try {
    const marker = localMediaMarker(file, "video/mp4", true);
    const payload = await prepareAnthropicPayload({ messages: [{ role: "user", content: `分析 ${marker}` }] }, ["text", "video"]);
    const content = (payload.messages as Array<{ content: unknown[] }>)[0]!.content;
    expect(content[1]).toMatchObject({ type: "document", source: { type: "base64", media_type: "video/mp4", data: "BwgJ" } });
    expect(JSON.stringify(payload)).not.toContain(file);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
